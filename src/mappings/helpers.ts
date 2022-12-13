/* eslint-disable prefer-const */
import { log, BigInt, BigDecimal, Address, EthereumEvent } from '@graphprotocol/graph-ts'
import { ERC20 } from '../types/Factory/ERC20'
import { ERC20SymbolBytes } from '../types/Factory/ERC20SymbolBytes'
import { ERC20NameBytes } from '../types/Factory/ERC20NameBytes'
import { User, Bundle, Token, LiquidityPosition, LiquidityPositionSnapshot, Pair } from '../types/schema'
import { Factory as FactoryContract } from '../types/templates/Pair/Factory'
import { TokenDefinition } from './tokenDefinition'

export const ADDRESS_ZERO = '0x0000000000000000000000000000000000000000'
export const FACTORY_ADDRESS = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f' // 写死的

export let ZERO_BI = BigInt.fromI32(0)
export let ONE_BI = BigInt.fromI32(1)
export let ZERO_BD = BigDecimal.fromString('0')
export let ONE_BD = BigDecimal.fromString('1')
export let BI_18 = BigInt.fromI32(18)

export let factoryContract = FactoryContract.bind(Address.fromString(FACTORY_ADDRESS))

// rebass tokens, dont count in tracked volume
export let UNTRACKED_PAIRS: string[] = ['0x9ea3b5b4ec044b70375236a281986106457b20ef']

export function exponentToBigDecimal(decimals: BigInt): BigDecimal {
  let bd = BigDecimal.fromString('1')
  for (let i = ZERO_BI; i.lt(decimals as BigInt); i = i.plus(ONE_BI)) {
    bd = bd.times(BigDecimal.fromString('10'))
  }
  return bd
}

export function bigDecimalExp18(): BigDecimal {
  return BigDecimal.fromString('1000000000000000000')
}

export function convertEthToDecimal(eth: BigInt): BigDecimal {
  return eth.toBigDecimal().div(exponentToBigDecimal(18))
}

export function convertTokenToDecimal(tokenAmount: BigInt, exchangeDecimals: BigInt): BigDecimal {
  if (exchangeDecimals == ZERO_BI) {
    return tokenAmount.toBigDecimal()
  }
  return tokenAmount.toBigDecimal().div(exponentToBigDecimal(exchangeDecimals)) // 除以decimals
}

export function equalToZero(value: BigDecimal): boolean {
  const formattedVal = parseFloat(value.toString())
  const zero = parseFloat(ZERO_BD.toString())
  if (zero == formattedVal) {
    return true
  }
  return false
}

export function isNullEthValue(value: string): boolean {
  return value == '0x0000000000000000000000000000000000000000000000000000000000000001'
}

// 根据token地址获取symbol
export function fetchTokenSymbol(tokenAddress: Address): string {
  // static definitions overrides
  // 如果是DGD,AAVE,LIF,SVD,TheDAO,HPB其中之一，就返回其TokenDefinition，否则返回null
  let staticDefinition = TokenDefinition.fromAddress(tokenAddress)
  if(staticDefinition != null) { // 如果非null，则返回其symbol
    return (staticDefinition as TokenDefinition).symbol
  }

  // 如果不是DGD,AAVE,LIF,SVD,TheDAO,HPB其中之一
  let contract = ERC20.bind(tokenAddress) // 用tokenAddress绑定ERC20 abi，得到ERC20合约
  let contractSymbolBytes = ERC20SymbolBytes.bind(tokenAddress) // 用tokenAddress绑定ERC20SymbolBytes abi，得到ERC20SymbolBytes合约

  // try types string and bytes32 for symbol
  let symbolValue = 'unknown' // 初始化为unknown
  let symbolResult = contract.try_symbol() // https://thegraph.com/docs/en/developing/assemblyscript-api/#handling-reverted-calls
  if (symbolResult.reverted) { // 如果调用ERC20的symbol方法回滚了，就继续调用ERC20SymbolBytes的symbol方法
    let symbolResultBytes = contractSymbolBytes.try_symbol()
    if (!symbolResultBytes.reverted) { // 如果调用ERC20SymbolBytes的symbol方法没有回滚，正常返回
      // for broken pairs that have no symbol function exposed
      // 对于没有暴露symbol函数的broken pairs
      if (!isNullEthValue(symbolResultBytes.value.toHexString())) { // 如果symbolResultBytes不等于0x0000000000000000000000000000000000000000000000000000000000000001
        symbolValue = symbolResultBytes.value.toString() // bytes转换为string类型
      }
    }
  } else {
    symbolValue = symbolResult.value // 本身就是string类型，不用转换
  }

  return symbolValue
}

// 根据token地址获取name
// 和fetchTokenSymbol很类似，就不注释了
export function fetchTokenName(tokenAddress: Address): string {
  // static definitions overrides
  let staticDefinition = TokenDefinition.fromAddress(tokenAddress)
  if(staticDefinition != null) {
    return (staticDefinition as TokenDefinition).name
  }

  let contract = ERC20.bind(tokenAddress)
  let contractNameBytes = ERC20NameBytes.bind(tokenAddress)

  // try types string and bytes32 for name
  let nameValue = 'unknown'
  let nameResult = contract.try_name()
  if (nameResult.reverted) {
    let nameResultBytes = contractNameBytes.try_name()
    if (!nameResultBytes.reverted) {
      // for broken exchanges that have no name function exposed
      if (!isNullEthValue(nameResultBytes.value.toHexString())) {
        nameValue = nameResultBytes.value.toString()
      }
    }
  } else {
    nameValue = nameResult.value
  }

  return nameValue
}

// 根据token地址获取totalSupply，有可能返回null
export function fetchTokenTotalSupply(tokenAddress: Address): BigInt {
  let contract = ERC20.bind(tokenAddress)
  let totalSupplyValue = null // 初始化为null
  let totalSupplyResult = contract.try_totalSupply() // 调用totalSupply方法
  if (!totalSupplyResult.reverted) { // 如果没有回滚
    totalSupplyValue = totalSupplyResult as i32
  }
  return BigInt.fromI32(totalSupplyValue as i32) // 有可能返回null
}

// 根据token地址获取decimals，有可能返回null
export function fetchTokenDecimals(tokenAddress: Address): BigInt {
  // static definitions overrides
  let staticDefinition = TokenDefinition.fromAddress(tokenAddress)
  if(staticDefinition != null) {
    return (staticDefinition as TokenDefinition).decimals
  }

  let contract = ERC20.bind(tokenAddress)
  // try types uint8 for decimals
  let decimalValue = null
  let decimalResult = contract.try_decimals()
  if (!decimalResult.reverted) {
    decimalValue = decimalResult.value
  }
  return BigInt.fromI32(decimalValue as i32) // 有可能返回null
}

// 创建一个LiquidityPosition，键为“Pair地址-User地址”，如果已经存在，就直接返回已经存在的LiquidityPosition
export function createLiquidityPosition(exchange: Address, user: Address): LiquidityPosition {
  // Pair地址-User地址
  let id = exchange
    .toHexString()
    .concat('-')
    .concat(user.toHexString())
  let liquidityTokenBalance = LiquidityPosition.load(id)
  if (liquidityTokenBalance === null) {
    let pair = Pair.load(exchange.toHexString()) // 根据Pair地址加载Pair entity
    // 由于“Pair地址-User地址”对应的LiquidityPosition不存在，这里是新建一个，说明这个User第一次在这个Pair添加流动性，所以Pair的liquidityProviderCount递增1,即新增了一个流动性提供者
    pair.liquidityProviderCount = pair.liquidityProviderCount.plus(ONE_BI)
    liquidityTokenBalance = new LiquidityPosition(id) // 新建一个LiquidityPosition
    liquidityTokenBalance.liquidityTokenBalance = ZERO_BD // 初始化为0
    liquidityTokenBalance.pair = exchange.toHexString() // pair地址
    liquidityTokenBalance.user = user.toHexString() // user地址
    liquidityTokenBalance.save() // 持久化
    pair.save() // 持久化
  }
  if (liquidityTokenBalance === null) log.error('LiquidityTokenBalance is null', [id])
  return liquidityTokenBalance as LiquidityPosition
}

export function createUser(address: Address): void {
  let user = User.load(address.toHexString())
  if (user === null) {
    user = new User(address.toHexString()) // 创建一个新User
    user.usdSwapped = ZERO_BD // 0
    user.save() // 持久化
  }
}

// 创建id为“Pair地址-User地址，再加上时间戳”的流动性快照
export function createLiquiditySnapshot(position: LiquidityPosition, event: EthereumEvent): void {
  let timestamp = event.block.timestamp.toI32() // 区块时间
  let bundle = Bundle.load('1')
  let pair = Pair.load(position.pair) // 用pair合约地址加载Pair entity
  let token0 = Token.load(pair.token0) // 加载token0对应的Token entity
  let token1 = Token.load(pair.token1) // 加载token1对应的Token entity

  // create new snapshot
  // Pair地址-User地址，再加上时间戳，创建一个LiquidityPositionSnapshot entity
  let snapshot = new LiquidityPositionSnapshot(position.id.concat(timestamp.toString()))
  snapshot.liquidityPosition = position.id // Pair地址-User地址
  snapshot.timestamp = timestamp // 区块时间
  snapshot.block = event.block.number.toI32() // 区块号
  snapshot.user = position.user // 指向User entity的引用
  snapshot.pair = position.pair // 指向Pair entity的引用
  snapshot.token0PriceUSD = token0.derivedETH.times(bundle.ethPrice) // 先转换为ETH，然后再乘以ETH的价格，以USD为单位
  snapshot.token1PriceUSD = token1.derivedETH.times(bundle.ethPrice)
  snapshot.reserve0 = pair.reserve0
  snapshot.reserve1 = pair.reserve1
  snapshot.reserveUSD = pair.reserveUSD
  snapshot.liquidityTokenTotalSupply = pair.totalSupply // LP tokens总供应量
  snapshot.liquidityTokenBalance = position.liquidityTokenBalance // User的tokens余额
  snapshot.liquidityPosition = position.id // Pair地址-User地址
  snapshot.save()
  position.save()
}
