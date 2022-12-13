/* eslint-disable prefer-const */
import { BigDecimal, BigInt, EthereumEvent } from '@graphprotocol/graph-ts'
import { Bundle, Pair, PairDayData, Token, TokenDayData, UniswapDayData, UniswapFactory } from '../types/schema'
import { PairHourData } from './../types/schema'
import { FACTORY_ADDRESS, ONE_BI, ZERO_BD, ZERO_BI } from './helpers'

export function updateUniswapDayData(event: EthereumEvent): UniswapDayData {
  // 加载UniswapFactory entity，代表全局
  let uniswap = UniswapFactory.load(FACTORY_ADDRESS)
  // 区块时间戳
  let timestamp = event.block.timestamp.toI32()
  // 自1970年以来的天数
  let dayID = timestamp / 86400
  // 当天开始的时间戳，以秒为单位
  let dayStartTimestamp = dayID * 86400
  // 加载UniswapDayData entity
  let uniswapDayData = UniswapDayData.load(dayID.toString())
  // 如果不存在，就新建一个，id很简单，就是dayID
  if (uniswapDayData === null) {
    uniswapDayData = new UniswapDayData(dayID.toString())
    uniswapDayData.date = dayStartTimestamp
    uniswapDayData.dailyVolumeUSD = ZERO_BD
    uniswapDayData.dailyVolumeETH = ZERO_BD
    uniswapDayData.totalVolumeUSD = ZERO_BD
    uniswapDayData.totalVolumeETH = ZERO_BD
    uniswapDayData.dailyVolumeUntracked = ZERO_BD
  }

  // 把工厂里当前的totalLiquidityUSD赋值给uniswapDayData.totalLiquidityUSD
  uniswapDayData.totalLiquidityUSD = uniswap.totalLiquidityUSD
  // 把工厂里当前的totalLiquidityETH赋值给uniswapDayData.totalLiquidityETH
  uniswapDayData.totalLiquidityETH = uniswap.totalLiquidityETH
  // txCount指的是戒指到当天为止，全局总共的交易数量
  uniswapDayData.txCount = uniswap.txCount
  // 持久化
  uniswapDayData.save()

  return uniswapDayData as UniswapDayData
}

export function updatePairDayData(event: EthereumEvent): PairDayData {
  // 区块时间戳
  let timestamp = event.block.timestamp.toI32()
  // 计算从1970年以来的第几天
  let dayID = timestamp / 86400
  // 计算这一天0点的时间戳
  let dayStartTimestamp = dayID * 86400
  // pair合约的地址+dayID（第几天）
  let dayPairID = event.address
    .toHexString()
    .concat('-')
    .concat(BigInt.fromI32(dayID).toString())
  // 加载pair合约
  let pair = Pair.load(event.address.toHexString())
  let pairDayData = PairDayData.load(dayPairID)
  // 如果PairDayData entity不存在，就新建一个
  if (pairDayData === null) {
    pairDayData = new PairDayData(dayPairID)
    pairDayData.date = dayStartTimestamp
    pairDayData.token0 = pair.token0
    pairDayData.token1 = pair.token1
    pairDayData.pairAddress = event.address
    pairDayData.dailyVolumeToken0 = ZERO_BD
    pairDayData.dailyVolumeToken1 = ZERO_BD
    pairDayData.dailyVolumeUSD = ZERO_BD
    pairDayData.dailyTxns = ZERO_BI
  }

  // 以下更新某一天PairDayData entity的内容，注意：除了dailyTxns是递增1,其他属性全部是覆盖之前的属性
  // LP tokens totalSupply
  pairDayData.totalSupply = pair.totalSupply
  pairDayData.reserve0 = pair.reserve0
  pairDayData.reserve1 = pair.reserve1
  pairDayData.reserveUSD = pair.reserveUSD
  pairDayData.dailyTxns = pairDayData.dailyTxns.plus(ONE_BI)
  // 持久化
  pairDayData.save()

  return pairDayData as PairDayData
}

export function updatePairHourData(event: EthereumEvent): PairHourData {
  // 区块时间戳
  let timestamp = event.block.timestamp.toI32()
  // 得到当前时间戳处于自1970年以来的第几个小时
  let hourIndex = timestamp / 3600 // get unique hour within unix history
  // 得到当前这个小时的起始时间，以秒为单位
  let hourStartUnix = hourIndex * 3600 // want the rounded effect
  // pair地址+hourIndex
  let hourPairID = event.address
    .toHexString()
    .concat('-')
    .concat(BigInt.fromI32(hourIndex).toString())
  // 加载Pair entity
  let pair = Pair.load(event.address.toHexString())
  // 加载PairHourData entity
  let pairHourData = PairHourData.load(hourPairID)
  // 如果为空，就新建一个PairHourData entity
  if (pairHourData === null) {
    pairHourData = new PairHourData(hourPairID)
    pairHourData.hourStartUnix = hourStartUnix
    pairHourData.pair = event.address.toHexString()
    pairHourData.hourlyVolumeToken0 = ZERO_BD
    pairHourData.hourlyVolumeToken1 = ZERO_BD
    pairHourData.hourlyVolumeUSD = ZERO_BD
    pairHourData.hourlyTxns = ZERO_BI
  }

  // 以下更新某一天PairHourData entity的内容，注意：除了hourlyTxns是递增1,其他属性全部是覆盖之前的属性
  pairHourData.totalSupply = pair.totalSupply
  pairHourData.reserve0 = pair.reserve0
  pairHourData.reserve1 = pair.reserve1
  pairHourData.reserveUSD = pair.reserveUSD
  pairHourData.hourlyTxns = pairHourData.hourlyTxns.plus(ONE_BI)
  pairHourData.save()

  return pairHourData as PairHourData
}

export function updateTokenDayData(token: Token, event: EthereumEvent): TokenDayData {
  let bundle = Bundle.load('1')
  let timestamp = event.block.timestamp.toI32()
  let dayID = timestamp / 86400
  let dayStartTimestamp = dayID * 86400
  let tokenDayID = token.id
    .toString()
    .concat('-')
    .concat(BigInt.fromI32(dayID).toString())

  // TokenDayData是token日数据
  let tokenDayData = TokenDayData.load(tokenDayID)
  if (tokenDayData === null) {
    tokenDayData = new TokenDayData(tokenDayID)
    tokenDayData.date = dayStartTimestamp
    tokenDayData.token = token.id
    // 更新token日价格，以USD计价
    tokenDayData.priceUSD = token.derivedETH.times(bundle.ethPrice)
    tokenDayData.dailyVolumeToken = ZERO_BD
    tokenDayData.dailyVolumeETH = ZERO_BD
    tokenDayData.dailyVolumeUSD = ZERO_BD
    tokenDayData.dailyTxns = ZERO_BI
    tokenDayData.totalLiquidityUSD = ZERO_BD
  }
  tokenDayData.priceUSD = token.derivedETH.times(bundle.ethPrice)
  tokenDayData.totalLiquidityToken = token.totalLiquidity
  tokenDayData.totalLiquidityETH = token.totalLiquidity.times(token.derivedETH as BigDecimal)
  tokenDayData.totalLiquidityUSD = tokenDayData.totalLiquidityETH.times(bundle.ethPrice)
  tokenDayData.dailyTxns = tokenDayData.dailyTxns.plus(ONE_BI)
  tokenDayData.save()

  /**
   * @todo test if this speeds up sync
   */
  // updateStoredTokens(tokenDayData as TokenDayData, dayID)
  // updateStoredPairs(tokenDayData as TokenDayData, dayPairID)

  return tokenDayData as TokenDayData
}
