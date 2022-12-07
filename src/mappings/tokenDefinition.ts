import {
  Address,
  BigInt,
} from "@graphprotocol/graph-ts"

// Initialize a Token Definition with the attributes
// 用属性初始化一个Token定义
export class TokenDefinition {
  address : Address
  symbol: string
  name: string
  decimals: BigInt

  // Initialize a Token Definition with its attributes
  // 用属性初始化一个Token定义
  constructor(address: Address, symbol: string, name: string, decimals: BigInt) {
    this.address = address
    this.symbol = symbol
    this.name = name
    this.decimals = decimals
  }

  // Get all tokens with a static defintion
  // 获取所有静态定义的tokens，包括6个tokens: DGD,AAVE,LIF,SVD,TheDAO,HPB
  static getStaticDefinitions(): Array<TokenDefinition> {
    let staticDefinitions = new Array<TokenDefinition>(6) // 固定长度为6,写死

    // Add DGD
    let tokenDGD = new TokenDefinition(
      Address.fromString('0xe0b7927c4af23765cb51314a0e0521a9645f0e2a'), // 主网上合约地址
      'DGD',
      'DGD',
      BigInt.fromI32(9)
    )
    staticDefinitions.push(tokenDGD) // 添加到TokenDefinition数组中

    // Add AAVE
    let tokenAAVE = new TokenDefinition(
      Address.fromString('0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9'),
      'AAVE',
      'Aave Token',
      BigInt.fromI32(18)
    )
    staticDefinitions.push(tokenAAVE) // 添加到TokenDefinition数组中

    // Add LIF
    let tokenLIF = new TokenDefinition(
      Address.fromString('0xeb9951021698b42e4399f9cbb6267aa35f82d59d'),
      'LIF',
      'Lif',
      BigInt.fromI32(18)
    )
    staticDefinitions.push(tokenLIF) // 添加到TokenDefinition数组中

    // Add SVD
    let tokenSVD = new TokenDefinition(
      Address.fromString('0xbdeb4b83251fb146687fa19d1c660f99411eefe3'),
      'SVD',
      'savedroid',
      BigInt.fromI32(18)
    )
    staticDefinitions.push(tokenSVD) // 添加到TokenDefinition数组中

    // Add TheDAO
    let tokenTheDAO = new TokenDefinition(
      Address.fromString('0xbb9bc244d798123fde783fcc1c72d3bb8c189413'),
      'TheDAO',
      'TheDAO',
      BigInt.fromI32(16)
    )
    staticDefinitions.push(tokenTheDAO) // 添加到TokenDefinition数组中

    // Add HPB
    let tokenHPB = new TokenDefinition(
      Address.fromString('0x38c6a68304cdefb9bec48bbfaaba5c5b47818bb2'),
      'HPB',
      'HPBCoin',
      BigInt.fromI32(18)
    )
    staticDefinitions.push(tokenHPB) // 添加到TokenDefinition数组中

    return staticDefinitions
  }

  // Helper for hardcoded tokens
  static fromAddress(tokenAddress: Address) : TokenDefinition | null {
    // 获取所有静态定义的tokens，包括6个tokens: DGD,AAVE,LIF,SVD,TheDAO,HPB
    let staticDefinitions = this.getStaticDefinitions()
    // Address类型转换为HexString类型
    let tokenAddressHex = tokenAddress.toHexString()

    // Search the definition using the address
    // 如果是DGD,AAVE,LIF,SVD,TheDAO,HPB其中之一，就返回其TokenDefinition
    for (let i = 0; i < staticDefinitions.length; i++) {
      let staticDefinition = staticDefinitions[i]
      if(staticDefinition.address.toHexString() == tokenAddressHex) {
        return staticDefinition
      }
    }

    // If not found, return null
    // 如果没有找到，就返回null
    return null
  }

}