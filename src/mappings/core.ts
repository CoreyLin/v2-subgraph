/* eslint-disable prefer-const */
import { BigInt, BigDecimal, store, Address } from '@graphprotocol/graph-ts'
import {
  Pair,
  Token,
  UniswapFactory,
  Transaction,
  Mint as MintEvent,
  Burn as BurnEvent,
  Swap as SwapEvent,
  Bundle
} from '../types/schema'
import { Pair as PairContract, Mint, Burn, Swap, Transfer, Sync } from '../types/templates/Pair/Pair'
import { updatePairDayData, updateTokenDayData, updateUniswapDayData, updatePairHourData } from './dayUpdates'
import { getEthPriceInUSD, findEthPerToken, getTrackedVolumeUSD, getTrackedLiquidityUSD } from './pricing'
import {
  convertTokenToDecimal,
  ADDRESS_ZERO,
  FACTORY_ADDRESS,
  ONE_BI,
  createUser,
  createLiquidityPosition,
  ZERO_BD,
  BI_18,
  createLiquiditySnapshot
} from './helpers'

// event Mint(address indexed sender, uint amount0, uint amount1);
function isCompleteMint(mintId: string): boolean {
  // 通过mintId加载MintEvent entity，如果sender是null，则返回false，如果为非null，则返回true
  return MintEvent.load(mintId).sender !== null // sufficient checks
}

// 处理Transfer(indexed address,indexed address,uint256)，注意：此处只会处理从pair合约发出的Transfer事件，而不会处理其他ERC20合约，比如USDT合约发出的事件，因为这已经在subgraph.yaml中通过source和template定义了
// - 忽略第一次添加流动性时产生的初始transfer，即_mint(address(0), MINIMUM_LIQUIDITY);
// - 取出event中的from和to地址，如果相应的User entity不存在，则分别创建新的User entity并持久化
// - 基于event所在的合约（pair合约）加载Pair entity；并且把PairContract template和pair合约地址绑定起来
// - 基于交易哈希获取Transaction entity，如果不存在，就新建一个。注意，Transaction里有一个属性叫mints，存储的是Mint entity的id
// - 如果Transaction entity的mints为空，或者最后一个mint id代表的Mint entity的sender属性已经被设置，为非空，则：
//   - 新建一个MintEvent entity，每次index递增1,因为mints.length会递增1
//   - 设置MintEvent entity的各个属性，除了sender不设置，因为在这里无法获得交易的sender是谁
//   - 把MintEvent entity的id添加到Transaction entity的mints属性中
// - 如果Transfer的to地址是pair合约地址，即pair合约是token接收地址，这就是移除流动性的场景，那么新建一个BurnEvent entity
// - 如果Transfer的to地址是零地址，并且from地址是pair合约地址，则说明是burn LP tokens
//	 - LP tokens的代币相应减少
//	 - 如果transaction.burns不为空，且最后一个BurnEvent的needsComplete为false，则新建一个BurnEvent entity，这个entity并不会覆盖currentBurn
//	 - 如果transaction.burns为空，则新建一个BurnEvent entity
//   - 如果Transfer的from不是零地址，也不是pair合约，则说明from是LP，to有可能是另一个EOA，也可能是pair地址，为from地址创建一个LiquidityPosition，键为“Pair地址-User地址”，如果已经存在，就直接返回已经存在的LiquidityPosition。并创建id为“Pair地址-User地址，再加上时间戳”的流动性快照。
//   - 如果Transfer的to不是零地址，也不是pair合约，则说明to是一个EOA或者一个第三方合约，为to地址创建一个LiquidityPosition，键为“Pair地址-User地址”，如果已经存在，就直接返回已经存在的LiquidityPosition。并创建id为“Pair地址-User地址，再加上时间戳”的流动性快照。
export function handleTransfer(event: Transfer): void {
  // ignore initial transfers for first adds
  // 第一次添加流动性时忽略初始transfer，即_mint(address(0), MINIMUM_LIQUIDITY);
  if (event.params.to.toHexString() == ADDRESS_ZERO && event.params.value.equals(BigInt.fromI32(1000))) {
    return
  }

  let factory = UniswapFactory.load(FACTORY_ADDRESS) // 加载UniswapFactory entity TODO:此处加载之后似乎没有使用，是否可以删掉
  let transactionHash = event.transaction.hash.toHexString()

  // user stats
  let from = event.params.from // from地址
  createUser(from) // 如果User不存在就创建一个新User并持久化
  let to = event.params.to // to地址
  createUser(to) // 如果User不存在就创建一个新User并持久化

  // get pair and load contract
  // Transfer event是pair合约发出来的，因为pair合约本身就是一个ERC20合约
  // 基于event所在的合约（pair合约）加载Pair entity
  let pair = Pair.load(event.address.toHexString())
  // 把PairContract template和pair合约地址绑定起来
  let pairContract = PairContract.bind(event.address)

  // liquidity token amount being transfered
  // 把Transfer的event除以decimals，固定是18，所以除以10**18
  let value = convertTokenToDecimal(event.params.value, BI_18)

  // get or create transaction
  // 获取或创建Transaction entity
  let transaction = Transaction.load(transactionHash)
  if (transaction === null) { // 如果还不存在，就新建一个
    transaction = new Transaction(transactionHash) // 交易哈希是唯一键
    transaction.blockNumber = event.block.number
    transaction.timestamp = event.block.timestamp
    transaction.mints = []
    transaction.burns = []
    transaction.swaps = []
  }

  // mints
  // 获取Transaction entity关联的Mint entity id列表
  // mint id是transaction hash + "-" + index in mints Transaction array
  let mints = transaction.mints
  if (from.toHexString() == ADDRESS_ZERO) { // 如果from地址是零地址，说明mint了LP token
    // update total supply
    // 更新pair entity的totalSupply，加上value
    pair.totalSupply = pair.totalSupply.plus(value)
    pair.save()

    // create new mint if no mints so far or if last one is done already
    // 如果到目前为止没有mints或者上一个mint已经完成，则创建新的mint
    // isCompleteMint: 通过mintId加载MintEvent entity，如果sender是null，则返回false，如果为非null，则返回true
    // mints[mints.length - 1]代表最后一个mint id，即transaction hash + "-" + index in mints Transaction array
    if (mints.length === 0 || isCompleteMint(mints[mints.length - 1])) {
      // 新建一个MintEvent entity，每次index递增1,因为mints.length会递增1
      // event Mint(address indexed sender, uint amount0, uint amount1);
      let mint = new MintEvent(
        event.transaction.hash
          .toHexString()
          .concat('-')
          .concat(BigInt.fromI32(mints.length).toString())
      )
      mint.transaction = transaction.id // 交易哈希
      mint.pair = pair.id // pair合约地址
      mint.to = to // Transfer中的to地址
      mint.liquidity = value // transfer的LP token数量，代表liquidity数量
      mint.timestamp = transaction.timestamp
      mint.transaction = transaction.id // TODO 重复了，可以删除
      mint.save()
      // 注意：以上并没有设置MintEvent entity的sender属性，因为在这里无法获得交易的sender是谁，Transfer event的to地址不一定是sender。所以，sender属性是在其他地方设置。

      // update mints in transaction
      // 把MintEvent entity的id添加到Transaction entity的mints属性中
      transaction.mints = mints.concat([mint.id])

      // save entities
      // 持久化
      transaction.save()
      factory.save() //TODO:可以删掉
    }
  }

  // case where direct send first on ETH withdrawls
  // 如果Transfer的to地址是pair合约地址，即pair合约是token接收地址，这就是移除流动性的场景，即发送LP tokens给pair合约
  if (event.params.to.toHexString() == pair.id) {
    let burns = transaction.burns
    // 基于交易哈希+index，创建一个BurnEvent entity
    let burn = new BurnEvent(
      event.transaction.hash
        .toHexString()
        .concat('-')
        .concat(BigInt.fromI32(burns.length).toString())
    )
    burn.transaction = transaction.id // 交易哈希
    burn.pair = pair.id // pair合约地址
    burn.liquidity = value // burn掉的流动性数量
    burn.timestamp = transaction.timestamp // 区块时间戳
    burn.to = event.params.to // pair合约地址
    burn.sender = event.params.from // LP地址
    burn.needsComplete = true // mark uncomplete in ETH case
    burn.transaction = transaction.id // TODO 重复了，删掉
    burn.save()

    // TODO: Consider using .concat() for handling array updates to protect
    // against unintended side effects for other code paths.
    // 更新transaction.burns
    burns.push(burn.id)
    transaction.burns = burns
    transaction.save()
  }

  // burn
  // 如果Transfer的to地址是零地址，并且from地址是pair合约地址，则说明是burn LP tokens
  if (event.params.to.toHexString() == ADDRESS_ZERO && event.params.from.toHexString() == pair.id) {
    // LP tokens的代币相应减少
    pair.totalSupply = pair.totalSupply.minus(value)
    pair.save()

    // this is a new instance of a logical burn
    let burns = transaction.burns
    let burn: BurnEvent
    if (burns.length > 0) { // 如果transaction.burns不为空
      let currentBurn = BurnEvent.load(burns[burns.length - 1]) // 取出最后一个BurnEvent
      if (currentBurn.needsComplete) { // 如果needsComplete为true，则不干什么，就把currentBurn赋给burn
        burn = currentBurn as BurnEvent
      } else { // 如果needsComplete为false，则新建一个BurnEvent entity，这个entity并不会覆盖currentBurn
        burn = new BurnEvent(
          event.transaction.hash
            .toHexString()
            .concat('-')
            .concat(BigInt.fromI32(burns.length).toString())
        )
        burn.transaction = transaction.id // 交易哈希
        burn.needsComplete = false // mark uncomplete in ETH case
        burn.pair = pair.id // pair合约地址
        burn.liquidity = value // burn掉的LP tokens数量
        burn.transaction = transaction.id // TODO 交易哈希，重复了，可以删掉
        burn.timestamp = transaction.timestamp // 区块时间
      }
    } else { // 如果transaction.burns为空，则新建一个BurnEvent entity
      burn = new BurnEvent(
        event.transaction.hash
          .toHexString()
          .concat('-')
          .concat(BigInt.fromI32(burns.length).toString())
      )
      burn.transaction = transaction.id
      burn.needsComplete = false
      burn.pair = pair.id
      burn.liquidity = value
      burn.transaction = transaction.id
      burn.timestamp = transaction.timestamp
    }

    // if this logical burn included a fee mint, account for this
    // 如果最后一个mints的sender是null，即没有设置，则进入if。这个适用于feeOn开启的情况，会在添加流动性和移除流动性的时候都调用pair合约的_mint，给feeTo铸造LP tokens
    if (mints.length !== 0 && !isCompleteMint(mints[mints.length - 1])) {//TODO
      let mint = MintEvent.load(mints[mints.length - 1])
      burn.feeTo = mint.to // fee给谁
      burn.feeLiquidity = mint.liquidity // fee对应的liquidity
      // remove the logical mint
      // 从持久层删除
      store.remove('Mint', mints[mints.length - 1])
      // update the transaction

      // TODO: Consider using .slice().pop() to protect against unintended
      // side effects for other code paths.
      mints.pop() // 删除最后一个元素
      transaction.mints = mints
      transaction.save() // 持久化
    }
    burn.save()
    // if accessing last one, replace it
    if (burn.needsComplete) {
      // TODO: Consider using .slice(0, -1).concat() to protect against
      // unintended side effects for other code paths.
      burns[burns.length - 1] = burn.id
    }
    // else add new one
    else {
      // TODO: Consider using .concat() for handling array updates to protect
      // against unintended side effects for other code paths.
      burns.push(burn.id)
    }
    transaction.burns = burns
    transaction.save()
  }

  // 如果Transfer的from不是零地址，也不是pair合约，则说明from是LP，to有可能是另一个EOA，也可能是pair地址
  if (from.toHexString() != ADDRESS_ZERO && from.toHexString() != pair.id) {
    // 为from地址创建一个LiquidityPosition，键为“Pair地址-User地址”，如果已经存在，就直接返回已经存在的LiquidityPosition
    let fromUserLiquidityPosition = createLiquidityPosition(event.address, from)
    // 更新此LiquidityPosition的liquidityTokenBalance，并持久化
    fromUserLiquidityPosition.liquidityTokenBalance = convertTokenToDecimal(pairContract.balanceOf(from), BI_18)
    fromUserLiquidityPosition.save()
    // 创建id为“Pair地址-User地址，再加上时间戳”的流动性快照
    createLiquiditySnapshot(fromUserLiquidityPosition, event)
  }

  // 如果Transfer的to不是零地址，也不是pair合约，则说明to是一个EOA或者一个第三方合约
  if (event.params.to.toHexString() != ADDRESS_ZERO && to.toHexString() != pair.id) {
    // 为to地址创建一个LiquidityPosition，键为“Pair地址-User地址”，如果已经存在，就直接返回已经存在的LiquidityPosition
    let toUserLiquidityPosition = createLiquidityPosition(event.address, to)
    // 更新此LiquidityPosition的liquidityTokenBalance，并持久化
    toUserLiquidityPosition.liquidityTokenBalance = convertTokenToDecimal(pairContract.balanceOf(to), BI_18)
    toUserLiquidityPosition.save()
    // 创建id为“Pair地址-User地址，再加上时间戳”的流动性快照
    createLiquiditySnapshot(toUserLiquidityPosition, event)
  }

  transaction.save()
}

export function handleSync(event: Sync): void {
  let pair = Pair.load(event.address.toHex())
  let token0 = Token.load(pair.token0)
  let token1 = Token.load(pair.token1)
  let uniswap = UniswapFactory.load(FACTORY_ADDRESS)

  // reset factory liquidity by subtracting onluy tarcked liquidity
  uniswap.totalLiquidityETH = uniswap.totalLiquidityETH.minus(pair.trackedReserveETH as BigDecimal)

  // reset token total liquidity amounts
  token0.totalLiquidity = token0.totalLiquidity.minus(pair.reserve0)
  token1.totalLiquidity = token1.totalLiquidity.minus(pair.reserve1)

  pair.reserve0 = convertTokenToDecimal(event.params.reserve0, token0.decimals)
  pair.reserve1 = convertTokenToDecimal(event.params.reserve1, token1.decimals)

  if (pair.reserve1.notEqual(ZERO_BD)) pair.token0Price = pair.reserve0.div(pair.reserve1)
  else pair.token0Price = ZERO_BD
  if (pair.reserve0.notEqual(ZERO_BD)) pair.token1Price = pair.reserve1.div(pair.reserve0)
  else pair.token1Price = ZERO_BD

  pair.save()

  // update ETH price now that reserves could have changed
  let bundle = Bundle.load('1')
  bundle.ethPrice = getEthPriceInUSD()
  bundle.save()

  token0.derivedETH = findEthPerToken(token0 as Token)
  token1.derivedETH = findEthPerToken(token1 as Token)
  token0.save()
  token1.save()

  // get tracked liquidity - will be 0 if neither is in whitelist
  let trackedLiquidityETH: BigDecimal
  if (bundle.ethPrice.notEqual(ZERO_BD)) {
    trackedLiquidityETH = getTrackedLiquidityUSD(pair.reserve0, token0 as Token, pair.reserve1, token1 as Token).div(
      bundle.ethPrice
    )
  } else {
    trackedLiquidityETH = ZERO_BD
  }

  // use derived amounts within pair
  pair.trackedReserveETH = trackedLiquidityETH
  pair.reserveETH = pair.reserve0
    .times(token0.derivedETH as BigDecimal)
    .plus(pair.reserve1.times(token1.derivedETH as BigDecimal))
  pair.reserveUSD = pair.reserveETH.times(bundle.ethPrice)

  // use tracked amounts globally
  uniswap.totalLiquidityETH = uniswap.totalLiquidityETH.plus(trackedLiquidityETH)
  uniswap.totalLiquidityUSD = uniswap.totalLiquidityETH.times(bundle.ethPrice)

  // now correctly set liquidity amounts for each token
  token0.totalLiquidity = token0.totalLiquidity.plus(pair.reserve0)
  token1.totalLiquidity = token1.totalLiquidity.plus(pair.reserve1)

  // save entities
  pair.save()
  uniswap.save()
  token0.save()
  token1.save()
}

// 处理Mint(indexed address,uint256,uint256)
// - 基于交易hash加载已经在handleTransfer里创建的Transaction entity
export function handleMint(event: Mint): void {//TODO
  // 在调用pair的mint方法的时候，会调用_mint(to, liquidity)，然后emit Transfer(address(0), to, value);
  // 在emit Transfer之后，才会emit Mint(msg.sender, amount0, amount1);
  // 所以，Transfer在前，Mint在后，都发生在一笔交易里
  // 此处的Transaction是在handleTransfer里创建的
  let transaction = Transaction.load(event.transaction.hash.toHexString()) // 根据交易哈希加载Transaction entity
  let mints = transaction.mints
  // 加载event Mint(address indexed sender, uint amount0, uint amount1)对应的MintEvent
  let mint = MintEvent.load(mints[mints.length - 1])

  let pair = Pair.load(event.address.toHex()) // 根据合约地址加载Pair合约entity
  let uniswap = UniswapFactory.load(FACTORY_ADDRESS) // 加载工厂合约entity

  // 加载token0,token1 entity
  let token0 = Token.load(pair.token0)
  let token1 = Token.load(pair.token1)

  // update exchange info (except balances, sync will cover that)
  // 更新交易所信息(除了balances，sync将涵盖)
  let token0Amount = convertTokenToDecimal(event.params.amount0, token0.decimals)
  let token1Amount = convertTokenToDecimal(event.params.amount1, token1.decimals)

  // update txn counts
  // 更新token0和token1各自的交易数量，分别加1
  token0.txCount = token0.txCount.plus(ONE_BI)
  token1.txCount = token1.txCount.plus(ONE_BI)

  // get new amounts of USD and ETH for tracking
  // 获取新的USD和ETH的数量进行跟踪
  let bundle = Bundle.load('1') // bundle保存了ETH的价格，以USD计价
  // 计算本次添加的amount0和amount1值多少USD
  // (token1的ETH价格 * token1Amount + token0的ETH价格 * token0Amount) * ETH价格
  let amountTotalUSD = token1.derivedETH
    .times(token1Amount)
    .plus(token0.derivedETH.times(token0Amount))
    .times(bundle.ethPrice)

  // update txn counts
  // Pair和Factory的交易数量都加1
  pair.txCount = pair.txCount.plus(ONE_BI)
  uniswap.txCount = uniswap.txCount.plus(ONE_BI)

  // save entities
  token0.save()
  token1.save()
  pair.save()
  uniswap.save()

  // event Mint(address indexed sender, uint amount0, uint amount1);
  mint.sender = event.params.sender
  mint.amount0 = token0Amount as BigDecimal
  mint.amount1 = token1Amount as BigDecimal
  mint.logIndex = event.logIndex
  mint.amountUSD = amountTotalUSD as BigDecimal
  mint.save()

  // update the LP position
  // 创建一个LiquidityPosition，键为“Pair地址-User地址”，如果已经存在，就直接返回已经存在的LiquidityPosition
  let liquidityPosition = createLiquidityPosition(event.address, mint.to as Address)
  createLiquiditySnapshot(liquidityPosition, event)//TODO

  // update day entities
  updatePairDayData(event)
  updatePairHourData(event)
  updateUniswapDayData(event)
  updateTokenDayData(token0 as Token, event)
  updateTokenDayData(token1 as Token, event)
}

export function handleBurn(event: Burn): void {
  let transaction = Transaction.load(event.transaction.hash.toHexString())

  // safety check
  if (transaction === null) {
    return
  }

  let burns = transaction.burns
  let burn = BurnEvent.load(burns[burns.length - 1])

  let pair = Pair.load(event.address.toHex())
  let uniswap = UniswapFactory.load(FACTORY_ADDRESS)

  //update token info
  let token0 = Token.load(pair.token0)
  let token1 = Token.load(pair.token1)
  let token0Amount = convertTokenToDecimal(event.params.amount0, token0.decimals)
  let token1Amount = convertTokenToDecimal(event.params.amount1, token1.decimals)

  // update txn counts
  token0.txCount = token0.txCount.plus(ONE_BI)
  token1.txCount = token1.txCount.plus(ONE_BI)

  // get new amounts of USD and ETH for tracking
  let bundle = Bundle.load('1')
  let amountTotalUSD = token1.derivedETH
    .times(token1Amount)
    .plus(token0.derivedETH.times(token0Amount))
    .times(bundle.ethPrice)

  // update txn counts
  uniswap.txCount = uniswap.txCount.plus(ONE_BI)
  pair.txCount = pair.txCount.plus(ONE_BI)

  // update global counter and save
  token0.save()
  token1.save()
  pair.save()
  uniswap.save()

  // update burn
  // burn.sender = event.params.sender
  burn.amount0 = token0Amount as BigDecimal
  burn.amount1 = token1Amount as BigDecimal
  // burn.to = event.params.to
  burn.logIndex = event.logIndex
  burn.amountUSD = amountTotalUSD as BigDecimal
  burn.save()

  // update the LP position
  let liquidityPosition = createLiquidityPosition(event.address, burn.sender as Address)
  createLiquiditySnapshot(liquidityPosition, event)

  // update day entities
  updatePairDayData(event)
  updatePairHourData(event)
  updateUniswapDayData(event)
  updateTokenDayData(token0 as Token, event)
  updateTokenDayData(token1 as Token, event)
}

export function handleSwap(event: Swap): void {
  let pair = Pair.load(event.address.toHexString())
  let token0 = Token.load(pair.token0)
  let token1 = Token.load(pair.token1)
  let amount0In = convertTokenToDecimal(event.params.amount0In, token0.decimals)
  let amount1In = convertTokenToDecimal(event.params.amount1In, token1.decimals)
  let amount0Out = convertTokenToDecimal(event.params.amount0Out, token0.decimals)
  let amount1Out = convertTokenToDecimal(event.params.amount1Out, token1.decimals)

  // totals for volume updates
  let amount0Total = amount0Out.plus(amount0In)
  let amount1Total = amount1Out.plus(amount1In)

  // ETH/USD prices
  let bundle = Bundle.load('1')

  // get total amounts of derived USD and ETH for tracking
  let derivedAmountETH = token1.derivedETH
    .times(amount1Total)
    .plus(token0.derivedETH.times(amount0Total))
    .div(BigDecimal.fromString('2'))
  let derivedAmountUSD = derivedAmountETH.times(bundle.ethPrice)

  // only accounts for volume through white listed tokens
  let trackedAmountUSD = getTrackedVolumeUSD(amount0Total, token0 as Token, amount1Total, token1 as Token, pair as Pair)

  let trackedAmountETH: BigDecimal
  if (bundle.ethPrice.equals(ZERO_BD)) {
    trackedAmountETH = ZERO_BD
  } else {
    trackedAmountETH = trackedAmountUSD.div(bundle.ethPrice)
  }

  // update token0 global volume and token liquidity stats
  token0.tradeVolume = token0.tradeVolume.plus(amount0In.plus(amount0Out))
  token0.tradeVolumeUSD = token0.tradeVolumeUSD.plus(trackedAmountUSD)
  token0.untrackedVolumeUSD = token0.untrackedVolumeUSD.plus(derivedAmountUSD)

  // update token1 global volume and token liquidity stats
  token1.tradeVolume = token1.tradeVolume.plus(amount1In.plus(amount1Out))
  token1.tradeVolumeUSD = token1.tradeVolumeUSD.plus(trackedAmountUSD)
  token1.untrackedVolumeUSD = token1.untrackedVolumeUSD.plus(derivedAmountUSD)

  // update txn counts
  token0.txCount = token0.txCount.plus(ONE_BI)
  token1.txCount = token1.txCount.plus(ONE_BI)

  // update pair volume data, use tracked amount if we have it as its probably more accurate
  pair.volumeUSD = pair.volumeUSD.plus(trackedAmountUSD)
  pair.volumeToken0 = pair.volumeToken0.plus(amount0Total)
  pair.volumeToken1 = pair.volumeToken1.plus(amount1Total)
  pair.untrackedVolumeUSD = pair.untrackedVolumeUSD.plus(derivedAmountUSD)
  pair.txCount = pair.txCount.plus(ONE_BI)
  pair.save()

  // update global values, only used tracked amounts for volume
  let uniswap = UniswapFactory.load(FACTORY_ADDRESS)
  uniswap.totalVolumeUSD = uniswap.totalVolumeUSD.plus(trackedAmountUSD)
  uniswap.totalVolumeETH = uniswap.totalVolumeETH.plus(trackedAmountETH)
  uniswap.untrackedVolumeUSD = uniswap.untrackedVolumeUSD.plus(derivedAmountUSD)
  uniswap.txCount = uniswap.txCount.plus(ONE_BI)

  // save entities
  pair.save()
  token0.save()
  token1.save()
  uniswap.save()

  let transaction = Transaction.load(event.transaction.hash.toHexString())
  if (transaction === null) {
    transaction = new Transaction(event.transaction.hash.toHexString())
    transaction.blockNumber = event.block.number
    transaction.timestamp = event.block.timestamp
    transaction.mints = []
    transaction.swaps = []
    transaction.burns = []
  }
  let swaps = transaction.swaps
  let swap = new SwapEvent(
    event.transaction.hash
      .toHexString()
      .concat('-')
      .concat(BigInt.fromI32(swaps.length).toString())
  )

  // update swap event
  swap.transaction = transaction.id
  swap.pair = pair.id
  swap.timestamp = transaction.timestamp
  swap.transaction = transaction.id
  swap.sender = event.params.sender
  swap.amount0In = amount0In
  swap.amount1In = amount1In
  swap.amount0Out = amount0Out
  swap.amount1Out = amount1Out
  swap.to = event.params.to
  swap.from = event.transaction.from
  swap.logIndex = event.logIndex
  // use the tracked amount if we have it
  swap.amountUSD = trackedAmountUSD === ZERO_BD ? derivedAmountUSD : trackedAmountUSD
  swap.save()

  // update the transaction

  // TODO: Consider using .concat() for handling array updates to protect
  // against unintended side effects for other code paths.
  swaps.push(swap.id)
  transaction.swaps = swaps
  transaction.save()

  // update day entities
  let pairDayData = updatePairDayData(event)
  let pairHourData = updatePairHourData(event)
  let uniswapDayData = updateUniswapDayData(event)
  let token0DayData = updateTokenDayData(token0 as Token, event)
  let token1DayData = updateTokenDayData(token1 as Token, event)

  // swap specific updating
  uniswapDayData.dailyVolumeUSD = uniswapDayData.dailyVolumeUSD.plus(trackedAmountUSD)
  uniswapDayData.dailyVolumeETH = uniswapDayData.dailyVolumeETH.plus(trackedAmountETH)
  uniswapDayData.dailyVolumeUntracked = uniswapDayData.dailyVolumeUntracked.plus(derivedAmountUSD)
  uniswapDayData.save()

  // swap specific updating for pair
  pairDayData.dailyVolumeToken0 = pairDayData.dailyVolumeToken0.plus(amount0Total)
  pairDayData.dailyVolumeToken1 = pairDayData.dailyVolumeToken1.plus(amount1Total)
  pairDayData.dailyVolumeUSD = pairDayData.dailyVolumeUSD.plus(trackedAmountUSD)
  pairDayData.save()

  // update hourly pair data
  pairHourData.hourlyVolumeToken0 = pairHourData.hourlyVolumeToken0.plus(amount0Total)
  pairHourData.hourlyVolumeToken1 = pairHourData.hourlyVolumeToken1.plus(amount1Total)
  pairHourData.hourlyVolumeUSD = pairHourData.hourlyVolumeUSD.plus(trackedAmountUSD)
  pairHourData.save()

  // swap specific updating for token0
  token0DayData.dailyVolumeToken = token0DayData.dailyVolumeToken.plus(amount0Total)
  token0DayData.dailyVolumeETH = token0DayData.dailyVolumeETH.plus(amount0Total.times(token0.derivedETH as BigDecimal))
  token0DayData.dailyVolumeUSD = token0DayData.dailyVolumeUSD.plus(
    amount0Total.times(token0.derivedETH as BigDecimal).times(bundle.ethPrice)
  )
  token0DayData.save()

  // swap specific updating
  token1DayData.dailyVolumeToken = token1DayData.dailyVolumeToken.plus(amount1Total)
  token1DayData.dailyVolumeETH = token1DayData.dailyVolumeETH.plus(amount1Total.times(token1.derivedETH as BigDecimal))
  token1DayData.dailyVolumeUSD = token1DayData.dailyVolumeUSD.plus(
    amount1Total.times(token1.derivedETH as BigDecimal).times(bundle.ethPrice)
  )
  token1DayData.save()
}
