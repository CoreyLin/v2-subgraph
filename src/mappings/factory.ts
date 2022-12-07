/* eslint-disable prefer-const */
import { log } from '@graphprotocol/graph-ts' // 引入日志
import { PairCreated } from '../types/Factory/Factory' // graph codegen生成的文件是放在src/types/目录下的，这里PairCreated是指Factory定义和发出的event
import { Bundle, Pair, Token, UniswapFactory } from '../types/schema'
import { Pair as PairTemplate } from '../types/templates' // Pair指定义在subgraph.yaml中的Pair template
import {
  FACTORY_ADDRESS,
  fetchTokenDecimals,
  fetchTokenName,
  fetchTokenSymbol,
  fetchTokenTotalSupply,
  ZERO_BD,
  ZERO_BI,
} from './helpers'

// 用于处理PairCreated(indexed address,indexed address,address,uint256)，即有新的pair被创建的场景
// - 如果UniswapFactory entity不存在，则新建一个UniswapFactory entity，并且创建一个Bundle entity用于存储ETH的价格
// - 如果token0 entity不存在，就新建一个
// - 如果token1 entity不存在，就新建一个
// - 新建一个Pair entity，把绝大多数属性都设置为默认的0，因为该pair还没有业务发生。从schema.graphql的定义中看，Pair entity的一些属性来自于其他一些entity，比如mints,burns,swaps分别来自于Mint,Burn,Swap entity
// - 基于定义在subgraph.yaml中的Pair template创建template，用于跟踪pair合约
export function handleNewPair(event: PairCreated): void { // 有新的pair合约创建时的处理函数
  // load factory (create if first exchange)
  let factory = UniswapFactory.load(FACTORY_ADDRESS) // 通过工厂合约地址加载UniswapFactory entity
  if (factory === null) { // 如果UniswapFactory entity不存在
    factory = new UniswapFactory(FACTORY_ADDRESS) // 新建一个UniswapFactory entity
    factory.pairCount = 0 // 创建的pair数量为0
    factory.totalVolumeETH = ZERO_BD // export let ZERO_BD = BigDecimal.fromString('0')
    factory.totalLiquidityETH = ZERO_BD
    factory.totalVolumeUSD = ZERO_BD
    factory.untrackedVolumeUSD = ZERO_BD
    factory.totalLiquidityUSD = ZERO_BD
    factory.txCount = ZERO_BI // export let ZERO_BI = BigInt.fromI32(0)

    // create new bundle
    let bundle = new Bundle('1') // Bundle用于存储ETH的价格，1是写死的，Bundle只在此处进行了创建，其他地方没有创建过Bundle
    bundle.ethPrice = ZERO_BD
    bundle.save()
  }
  factory.pairCount = factory.pairCount + 1 // 由于创建了一个新的pair，所以加1
  factory.save() // 持久化

  // create the tokens 创建tokens
  let token0 = Token.load(event.params.token0.toHexString()) // 用token0的地址加载token0
  let token1 = Token.load(event.params.token1.toHexString()) // 用token1的地址加载token1

  // fetch info if null
  if (token0 === null) { // 如果token0 entity不存在，就新建一个
    token0 = new Token(event.params.token0.toHexString())
    // 根据token地址获取symbol
    token0.symbol = fetchTokenSymbol(event.params.token0)
    // 根据token地址获取name
    token0.name = fetchTokenName(event.params.token0)
    // 根据token地址获取totalSupply，有可能返回null
    token0.totalSupply = fetchTokenTotalSupply(event.params.token0)
    // 根据token地址获取decimals，有可能返回null
    let decimals = fetchTokenDecimals(event.params.token0)

    // bail if we couldn't figure out the decimals
    // 如果获取不到decimals就退出
    if (decimals === null) {
      log.debug('mybug the decimal on token 0 was null', [])
      return
    }

    token0.decimals = decimals
    // 把以下的属性都初始化为0
    token0.derivedETH = ZERO_BD
    token0.tradeVolume = ZERO_BD
    token0.tradeVolumeUSD = ZERO_BD
    token0.untrackedVolumeUSD = ZERO_BD
    token0.totalLiquidity = ZERO_BD
    // token0.allPairs = []
    token0.txCount = ZERO_BI
  }

  // fetch info if null
  if (token1 === null) { // 如果token1 entity不存在，就新建一个
    token1 = new Token(event.params.token1.toHexString())
    token1.symbol = fetchTokenSymbol(event.params.token1)
    token1.name = fetchTokenName(event.params.token1)
    token1.totalSupply = fetchTokenTotalSupply(event.params.token1)
    let decimals = fetchTokenDecimals(event.params.token1)

    // bail if we couldn't figure out the decimals
    if (decimals === null) {
      return
    }
    token1.decimals = decimals
    token1.derivedETH = ZERO_BD
    token1.tradeVolume = ZERO_BD
    token1.tradeVolumeUSD = ZERO_BD
    token1.untrackedVolumeUSD = ZERO_BD
    token1.totalLiquidity = ZERO_BD
    // token1.allPairs = []
    token1.txCount = ZERO_BI
  }

  // 新建Pair entity
  let pair = new Pair(event.params.pair.toHexString()) as Pair
  pair.token0 = token0.id
  pair.token1 = token1.id
  // 刚刚创建pair，所以pair的大部分属性初始化为0
  pair.liquidityProviderCount = ZERO_BI // 0
  pair.createdAtTimestamp = event.block.timestamp // 区块时间
  pair.createdAtBlockNumber = event.block.number // 区块号
  pair.txCount = ZERO_BI // 0
  pair.reserve0 = ZERO_BD // 0
  pair.reserve1 = ZERO_BD // 0
  pair.trackedReserveETH = ZERO_BD // 0
  pair.reserveETH = ZERO_BD // 0
  pair.reserveUSD = ZERO_BD // 0
  pair.totalSupply = ZERO_BD // 0
  pair.volumeToken0 = ZERO_BD // 0
  pair.volumeToken1 = ZERO_BD // 0
  pair.volumeUSD = ZERO_BD // 0
  pair.untrackedVolumeUSD = ZERO_BD // 0
  pair.token0Price = ZERO_BD // 0
  pair.token1Price = ZERO_BD // 0

  // create the tracked contract based on the template
  // 基于定义在subgraph.yaml中的Pair template创建template，用于跟踪pair合约
  // event.params.pair是pair合约的地址
  PairTemplate.create(event.params.pair)

  // save updated values
  // 持久化
  token0.save()
  token1.save()
  pair.save()
  factory.save()
}
