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
    if (mints.length !== 0 && !isCompleteMint(mints[mints.length - 1])) {
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

// 处理 Sync(uint112,uint112)
export function handleSync(event: Sync): void {
  let pair = Pair.load(event.address.toHex()) // 加载pair合约entity
  let token0 = Token.load(pair.token0) // 加载token0 entity
  let token1 = Token.load(pair.token1) // 加载token1 entity
  let uniswap = UniswapFactory.load(FACTORY_ADDRESS) // 加载 UniswapFactory entity

  // reset factory liquidity by subtracting onluy tarcked liquidity
  // 通过仅减去跟踪的流动性来重置工厂流动性
  uniswap.totalLiquidityETH = uniswap.totalLiquidityETH.minus(pair.trackedReserveETH as BigDecimal)

  // reset token total liquidity amounts
  // 重置token总流动性数量。
  token0.totalLiquidity = token0.totalLiquidity.minus(pair.reserve0)
  token1.totalLiquidity = token1.totalLiquidity.minus(pair.reserve1)

  // 用最新的Sync event里的reserve0,reserve1给pair赋值，即更新pair的reserve
  pair.reserve0 = convertTokenToDecimal(event.params.reserve0, token0.decimals)
  pair.reserve1 = convertTokenToDecimal(event.params.reserve1, token1.decimals)

  // 如果最新的reserve1不为0,则计算token0Price，就覆盖了之前的值；如果为0,则token0Price置为0
  if (pair.reserve1.notEqual(ZERO_BD)) pair.token0Price = pair.reserve0.div(pair.reserve1)
  else pair.token0Price = ZERO_BD
  // 如果最新的reserve0不为0,则计算token1Price，就覆盖了之前的值；如果为0,则token1Price置为0
  if (pair.reserve0.notEqual(ZERO_BD)) pair.token1Price = pair.reserve1.div(pair.reserve0)
  else pair.token1Price = ZERO_BD

  pair.save() // 持久化

  // update ETH price now that reserves could have changed
  // 更新ETH价格，现在储备可能已经改变
  let bundle = Bundle.load('1')
  // 返回daiPair,usdcPair,usdtPair中ETH价格的平均值，如果pair都不存在，返回0
  bundle.ethPrice = getEthPriceInUSD()
  bundle.save()

  // 通过graph搜索每个token的衍生Eth，即每个token值多少ETH，机制就是通过白名单token的pair来获取。
  // 找到一个token0值多少ETH
  token0.derivedETH = findEthPerToken(token0 as Token)
  // 找到一个token1值多少ETH
  token1.derivedETH = findEthPerToken(token1 as Token)
  // 持久化
  token0.save()
  token1.save()

  // get tracked liquidity - will be 0 if neither is in whitelist
  // 获得跟踪流动性-如果两者都不在白名单中，将为0
  let trackedLiquidityETH: BigDecimal
  // 如果ETH price不为0
  if (bundle.ethPrice.notEqual(ZERO_BD)) {
    // 接受tokens和金额，根据token白名单返回对应的USD金额，然后再除以ETH价格，就得到了pair reserve0和reserve1总共值多少ETH
    trackedLiquidityETH = getTrackedLiquidityUSD(pair.reserve0, token0 as Token, pair.reserve1, token1 as Token).div(
      bundle.ethPrice
    )
  } else {
    // 如果ETH price为0,则返回0
    trackedLiquidityETH = ZERO_BD
  }

  // use derived amounts within pair
  // 注意：trackedReserveETH和reserveETH都代表pair里的reserve值多少ETH，但计算方式不同，trackedReserveETH是先计算USD价值，然后再转换为ETH价值
  pair.trackedReserveETH = trackedLiquidityETH
  pair.reserveETH = pair.reserve0
    .times(token0.derivedETH as BigDecimal)
    .plus(pair.reserve1.times(token1.derivedETH as BigDecimal))
  pair.reserveUSD = pair.reserveETH.times(bundle.ethPrice)

  // use tracked amounts globally
  // 更新整个uniswap所有的pair总共的reserve分别值多少ETH和多少USD，即更新uniswap整体的锁仓量TVL
  uniswap.totalLiquidityETH = uniswap.totalLiquidityETH.plus(trackedLiquidityETH)
  uniswap.totalLiquidityUSD = uniswap.totalLiquidityETH.times(bundle.ethPrice)

  // now correctly set liquidity amounts for each token
  // 更新每种token在整个uniswap中的流动性金额
  token0.totalLiquidity = token0.totalLiquidity.plus(pair.reserve0)
  token1.totalLiquidity = token1.totalLiquidity.plus(pair.reserve1)

  // save entities
  // 持久化
  pair.save()
  uniswap.save()
  token0.save()
  token1.save()
}

// 处理Mint(indexed address,uint256,uint256)
// - 基于交易hash加载已经在handleTransfer里创建的Transaction entity
export function handleMint(event: Mint): void {
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
  createLiquiditySnapshot(liquidityPosition, event)

  // update day entities
  updatePairDayData(event)
  updatePairHourData(event)
  updateUniswapDayData(event)
  updateTokenDayData(token0 as Token, event)
  updateTokenDayData(token1 as Token, event)
}

// 处理 event Burn(address indexed sender, uint amount0, uint amount1, address indexed to);
export function handleBurn(event: Burn): void {
  let transaction = Transaction.load(event.transaction.hash.toHexString())

  // safety check
  if (transaction === null) {
    return
  }

  // 取出交易entity中保存的最后一个burn，然后加载BurnEvent entity
  let burns = transaction.burns
  let burn = BurnEvent.load(burns[burns.length - 1])

  // 根据pair地址加载 Pair entity
  let pair = Pair.load(event.address.toHex())
  // 加载全局 UniswapFactory entity
  let uniswap = UniswapFactory.load(FACTORY_ADDRESS)

  //update token info
  // 更新token信息
  let token0 = Token.load(pair.token0)
  let token1 = Token.load(pair.token1)
  let token0Amount = convertTokenToDecimal(event.params.amount0, token0.decimals)
  let token1Amount = convertTokenToDecimal(event.params.amount1, token1.decimals)

  // update txn counts
  // token0和token1的交易数量递增1
  token0.txCount = token0.txCount.plus(ONE_BI)
  token1.txCount = token1.txCount.plus(ONE_BI)

  // get new amounts of USD and ETH for tracking
  // 获取本次Burn的token0和token1值多少USD
  let bundle = Bundle.load('1')
  let amountTotalUSD = token1.derivedETH
    .times(token1Amount)
    .plus(token0.derivedETH.times(token0Amount))
    .times(bundle.ethPrice)

  // update txn counts
  // 更新全局交易数量和pair交易数量
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
  // 由于进行了移除流动性操作，所以LP的position就减少了，进行更新
  let liquidityPosition = createLiquidityPosition(event.address, burn.sender as Address)
  // 创建该LP的流动性快照
  createLiquiditySnapshot(liquidityPosition, event)

  // update day entities
  // 更新 day entities
  updatePairDayData(event)
  updatePairHourData(event)
  updateUniswapDayData(event)
  updateTokenDayData(token0 as Token, event)
  updateTokenDayData(token1 as Token, event)
}

/*
处理
    event Swap(
        address indexed sender,
        uint amount0In,
        uint amount1In,
        uint amount0Out,
        uint amount1Out,
        address indexed to
    );
*/
export function handleSwap(event: Swap): void {
  let pair = Pair.load(event.address.toHexString()) // 加载 Pair entity
  let token0 = Token.load(pair.token0) // 加载 token0 entity
  let token1 = Token.load(pair.token1) // 加载 token1 entity
  let amount0In = convertTokenToDecimal(event.params.amount0In, token0.decimals)
  let amount1In = convertTokenToDecimal(event.params.amount1In, token1.decimals)
  let amount0Out = convertTokenToDecimal(event.params.amount0Out, token0.decimals)
  let amount1Out = convertTokenToDecimal(event.params.amount1Out, token1.decimals)

  // totals for volume updates
  let amount0Total = amount0Out.plus(amount0In)
  let amount1Total = amount1Out.plus(amount1In)

  // ETH/USD prices
  // 得到ETH价格
  let bundle = Bundle.load('1')

  // get total amounts of derived USD and ETH for tracking
  // 获得衍生的USD和ETH的总金额进行跟踪，这里是跟踪交易量，因为swap就会产生volume
  // (amountIn对应的ETH+amountOut对应的ETH)/2，即取平均值，然后再乘以USD，得到本次swap交易的交易量，以USD计价
  let derivedAmountETH = token1.derivedETH
    .times(amount1Total)
    .plus(token0.derivedETH.times(amount0Total))
    .div(BigDecimal.fromString('2'))
  // 衍生的ETH数量 * ETH的价格 = 衍生的USD数量
  let derivedAmountUSD = derivedAmountETH.times(bundle.ethPrice)

  // only accounts for volume through white listed tokens
  // 仅通过白名单tokens来计算本次swap的交易量（以USD计价）
  // 接受tokens和amounts，根据代币白名单返回跟踪交易量金额，以USD计价
  let trackedAmountUSD = getTrackedVolumeUSD(amount0Total, token0 as Token, amount1Total, token1 as Token, pair as Pair)

  let trackedAmountETH: BigDecimal
  if (bundle.ethPrice.equals(ZERO_BD)) {
    trackedAmountETH = ZERO_BD
  } else {
    // 得到本次swap的交易量（以ETH计价）
    trackedAmountETH = trackedAmountUSD.div(bundle.ethPrice)
  }

  // update token0 global volume and token liquidity stats
  // 更新token0全局交易量和token流动性统计数据
  // 更新token0的交易量
  token0.tradeVolume = token0.tradeVolume.plus(amount0In.plus(amount0Out))
  // 更新token0的交易量，以USD计价
  token0.tradeVolumeUSD = token0.tradeVolumeUSD.plus(trackedAmountUSD)
  // 更新token0的未跟踪交易量，以USD计价
  token0.untrackedVolumeUSD = token0.untrackedVolumeUSD.plus(derivedAmountUSD)

  // update token1 global volume and token liquidity stats
  token1.tradeVolume = token1.tradeVolume.plus(amount1In.plus(amount1Out))
  token1.tradeVolumeUSD = token1.tradeVolumeUSD.plus(trackedAmountUSD)
  token1.untrackedVolumeUSD = token1.untrackedVolumeUSD.plus(derivedAmountUSD)

  // update txn counts
  // token0和token1的交易数量递增1
  token0.txCount = token0.txCount.plus(ONE_BI)
  token1.txCount = token1.txCount.plus(ONE_BI)

  // update pair volume data, use tracked amount if we have it as its probably more accurate
  // 更新pair交易量数据，如果我们有跟踪交易量，则使用跟踪交易量，因为它可能更准确
  // 更新pair跟踪交易量，以USD计价
  pair.volumeUSD = pair.volumeUSD.plus(trackedAmountUSD)
  // 更新pair的token0交易量
  pair.volumeToken0 = pair.volumeToken0.plus(amount0Total)
  // 更新pair的token1交易量
  pair.volumeToken1 = pair.volumeToken1.plus(amount1Total)
  // 更新pair的未跟踪交易量，以USD计价
  pair.untrackedVolumeUSD = pair.untrackedVolumeUSD.plus(derivedAmountUSD)
  // 更新pair的swap交易数量，递增1
  pair.txCount = pair.txCount.plus(ONE_BI)
  // 持久化
  pair.save()

  // update global values, only used tracked amounts for volume
  // 更新全局值，只使用跟踪量的交易量
  // 加载 UniswapFactory，就代表uniswap全局
  let uniswap = UniswapFactory.load(FACTORY_ADDRESS)
  // 更新全局跟踪交易量，以USD计价
  uniswap.totalVolumeUSD = uniswap.totalVolumeUSD.plus(trackedAmountUSD)
  // 更新全局跟踪交易量，以ETH计价
  uniswap.totalVolumeETH = uniswap.totalVolumeETH.plus(trackedAmountETH)
  // 更新全局未跟踪交易量，以USD计价
  uniswap.untrackedVolumeUSD = uniswap.untrackedVolumeUSD.plus(derivedAmountUSD)
  // 全局交易数量递增1
  uniswap.txCount = uniswap.txCount.plus(ONE_BI)

  // save entities
  // 持久化
  pair.save()
  token0.save()
  token1.save()
  uniswap.save()

  // 根据交易哈希加载 Transaction entity
  let transaction = Transaction.load(event.transaction.hash.toHexString())
  // 如果 Transaction entity还不存在，就新建一个，只更新区块号和时间戳
  if (transaction === null) {
    transaction = new Transaction(event.transaction.hash.toHexString())
    transaction.blockNumber = event.block.number
    transaction.timestamp = event.block.timestamp
    transaction.mints = []
    transaction.swaps = []
    transaction.burns = []
  }
  // 取出 Transaction entity的swaps，有可能为空
  let swaps = transaction.swaps
  // 为当前这个Swap事件创建一个 SwapEvent entity，id为交易哈希+index
  let swap = new SwapEvent(
    event.transaction.hash
      .toHexString()
      .concat('-')
      .concat(BigInt.fromI32(swaps.length).toString())
  )

  // update swap event
  swap.transaction = transaction.id // 交易哈希
  swap.pair = pair.id // pair合约地址
  swap.timestamp = transaction.timestamp // 时间戳
  swap.transaction = transaction.id
  swap.sender = event.params.sender // swap交易发起者
  swap.amount0In = amount0In
  swap.amount1In = amount1In
  swap.amount0Out = amount0Out
  swap.amount1Out = amount1Out
  swap.to = event.params.to // 交换的代币发给谁
  swap.from = event.transaction.from // 交易发起者
  swap.logIndex = event.logIndex // log index
  // use the tracked amount if we have it
  // 本笔swap交易的金额，以USD计价
  swap.amountUSD = trackedAmountUSD === ZERO_BD ? derivedAmountUSD : trackedAmountUSD
  // 持久化
  swap.save()

  // update the transaction
  // 更新交易

  // TODO: Consider using .concat() for handling array updates to protect
  // against unintended side effects for other code paths.
  swaps.push(swap.id)
  transaction.swaps = swaps
  transaction.save()

  // update day entities
  // 更新day entity
  let pairDayData = updatePairDayData(event)
  // 更新pair entity
  let pairHourData = updatePairHourData(event)
  // 更新uniswap全局日数据
  let uniswapDayData = updateUniswapDayData(event)
  // 更新token日数据
  let token0DayData = updateTokenDayData(token0 as Token, event)
  let token1DayData = updateTokenDayData(token1 as Token, event)

  // swap specific updating
  // Swap特定的更新，日交易量
  uniswapDayData.dailyVolumeUSD = uniswapDayData.dailyVolumeUSD.plus(trackedAmountUSD)
  uniswapDayData.dailyVolumeETH = uniswapDayData.dailyVolumeETH.plus(trackedAmountETH)
  uniswapDayData.dailyVolumeUntracked = uniswapDayData.dailyVolumeUntracked.plus(derivedAmountUSD)
  uniswapDayData.save()

  // swap specific updating for pair
  // pair的token0,token1日交易量，以及以USD计价的交易量
  pairDayData.dailyVolumeToken0 = pairDayData.dailyVolumeToken0.plus(amount0Total)
  pairDayData.dailyVolumeToken1 = pairDayData.dailyVolumeToken1.plus(amount1Total)
  pairDayData.dailyVolumeUSD = pairDayData.dailyVolumeUSD.plus(trackedAmountUSD)
  pairDayData.save()

  // update hourly pair data
  // pair的token0,token1小时交易量，以及以USD计价的交易量
  pairHourData.hourlyVolumeToken0 = pairHourData.hourlyVolumeToken0.plus(amount0Total)
  pairHourData.hourlyVolumeToken1 = pairHourData.hourlyVolumeToken1.plus(amount1Total)
  pairHourData.hourlyVolumeUSD = pairHourData.hourlyVolumeUSD.plus(trackedAmountUSD)
  pairHourData.save()

  // swap specific updating for token0
  // token0的日交易量
  token0DayData.dailyVolumeToken = token0DayData.dailyVolumeToken.plus(amount0Total)
  token0DayData.dailyVolumeETH = token0DayData.dailyVolumeETH.plus(amount0Total.times(token0.derivedETH as BigDecimal))
  token0DayData.dailyVolumeUSD = token0DayData.dailyVolumeUSD.plus(
    amount0Total.times(token0.derivedETH as BigDecimal).times(bundle.ethPrice)
  )
  token0DayData.save()

  // swap specific updating
  // token1的日交易量
  token1DayData.dailyVolumeToken = token1DayData.dailyVolumeToken.plus(amount1Total)
  token1DayData.dailyVolumeETH = token1DayData.dailyVolumeETH.plus(amount1Total.times(token1.derivedETH as BigDecimal))
  token1DayData.dailyVolumeUSD = token1DayData.dailyVolumeUSD.plus(
    amount1Total.times(token1.derivedETH as BigDecimal).times(bundle.ethPrice)
  )
  token1DayData.save()
}
