import { ethers, upgrades } from 'hardhat'
import { Contract, Signer, BigNumber, BigNumberish } from 'ethers'
import { expect } from 'chai'

const PRICE_DECIMALS = 8
const DECIMALS = 18
const NAME = 'Button Bitcoin'
const SYMBOL = 'BTN-BTC'

const toOracleValue = (v: string): BigNumber =>
  ethers.utils.parseUnits(v, PRICE_DECIMALS)

const toFixedPtAmt = (a: string): BigNumber =>
  ethers.utils.parseUnits(a, DECIMALS)

const transferAmount = toFixedPtAmt('10')
const unitTokenAmount = toFixedPtAmt('1')

let accounts: Signer[],
  deployer: Signer,
  deployerAddress: string,
  userA: Signer,
  userAAddress: string,
  userB: Signer,
  userBAddress: string,
  userC: Signer,
  userCAddress: string,
  mockBTC: Contract,
  mockOracle: Contract,
  buttonToken: Contract,
  collateralSupply: BigNumber,
  cbA: BigNumber,
  cbB: BigNumber

async function setupContracts() {
  accounts = await ethers.getSigners()
  deployer = accounts[0]
  userA = accounts[1]
  userB = accounts[2]
  userC = accounts[3]

  deployerAddress = await deployer.getAddress()
  userAAddress = await userA.getAddress()
  userBAddress = await userB.getAddress()
  userCAddress = await userC.getAddress()

  const erc20Factory = await ethers.getContractFactory('MockERC20')
  mockBTC = await erc20Factory
    .connect(deployer)
    .deploy('Wood Bitcoin', 'WOOD-BTC')

  const oracleFactory = await ethers.getContractFactory('MockOracle')
  mockOracle = await oracleFactory.connect(deployer).deploy()
  await mockOracle.setData(toOracleValue('10000'), true)

  const buttonTokenFactory = await ethers.getContractFactory('ButtonToken')
  buttonToken = await buttonTokenFactory
    .connect(deployer)
    .deploy(mockBTC.address, NAME, SYMBOL, mockOracle.address)
}

function eqAprox(x: BigNumber, y: BigNumberish, diff: BigNumberish = '1') {
  expect(x.sub(y).abs()).lte(diff).gte('0')
}

describe('ButtonToken', () => {
  before('setup ButtonToken contract', setupContracts)

  it('should reject any ether sent to it', async function () {
    const user = accounts[1]
    await expect(user.sendTransaction({ to: buttonToken.address, value: 1 })).to
      .be.reverted
  })
})

describe('ButtonToken:Initialization', () => {
  beforeEach('setup ButtonToken contract', setupContracts)

  it('should set the owner', async function () {
    expect(await buttonToken.owner()).to.eq(deployerAddress)
  })

  it('should set the asset reference', async function () {
    expect(await buttonToken.asset()).to.eq(mockBTC.address)
  })

  it('should set detailed erc20 info parameters', async function () {
    expect(await buttonToken.name()).to.eq(NAME)
    expect(await buttonToken.symbol()).to.eq(SYMBOL)
    expect(await buttonToken.decimals()).to.eq(await mockBTC.decimals())
  })

  it('should set the erc20 balance and supply parameters', async function () {
    eqAprox(await buttonToken.totalSupply(), '0')
    expect(await buttonToken.scaledTotalSupply()).to.eq('0')
    eqAprox(await buttonToken.balanceOf(deployerAddress), '0')
    expect(await buttonToken.scaledBalanceOf(deployerAddress)).to.eq('0')
  })

  it('should set the oracle price and reference', async function () {
    expect(await buttonToken.priceOracle()).to.eq(mockOracle.address)
    expect(await buttonToken.lastPriceUpdateTimestampSec()).to.gte(0)
    expect(await buttonToken.minPriceUpdateIntervalSec()).to.eq(3600)
  })
})

describe('ButtonToken:resetPriceOracle', async () => {
  beforeEach('setup ButtonToken contract', setupContracts)

  describe('when invoked by non owner', function () {
    it('should revert', async function () {
      const oracleFactory = await ethers.getContractFactory('MockOracle')
      mockOracle = await oracleFactory.connect(deployer).deploy()
      await mockOracle.setData(toOracleValue('45000'), true)

      await expect(
        buttonToken.connect(userA).resetPriceOracle(mockOracle.address),
      ).to.be.revertedWith('Ownable: caller is not the owner')
    })
  })

  describe('when the new price oracle is NOT valid', function () {
    it('should revert', async function () {
      const oracleFactory = await ethers.getContractFactory('MockOracle')
      mockOracle = await oracleFactory.connect(deployer).deploy()
      await mockOracle.setData(toOracleValue('45000'), false)

      await expect(
        buttonToken.connect(deployer).resetPriceOracle(mockOracle.address),
      ).to.be.revertedWith('ButtonToken: unable to fetch data from oracle')
    })
  })

  describe('when the new price oracle is valid', function () {
    it('should update the reference and rebase with new price', async function () {
      const oracleFactory = await ethers.getContractFactory('MockOracle')
      mockOracle = await oracleFactory.connect(deployer).deploy()
      await mockOracle.setData(toOracleValue('45000'), true)

      expect(await buttonToken.priceOracle()).to.not.eq(mockOracle.address)
      const timeBefore = await buttonToken.lastPriceUpdateTimestampSec()

      await expect(
        buttonToken.connect(deployer).resetPriceOracle(mockOracle.address),
      )
        .to.emit(buttonToken, 'Rebase')
        .withArgs(toOracleValue('45000'))
        .to.emit(buttonToken, 'PriceOracleUpdated')
        .withArgs(mockOracle.address)

      expect(await buttonToken.priceOracle()).to.eq(mockOracle.address)
      expect(await buttonToken.lastPriceUpdateTimestampSec()).to.gte(timeBefore)
      expect(await buttonToken.currentPrice()).to.eq(toOracleValue('45000'))
    })
  })
})

describe('ButtonToken:setMinUpdateIntervalSec', async () => {
  beforeEach('setup ButtonToken contract', setupContracts)

  describe('when invoked by non owner', function () {
    it('should revert', async function () {
      await expect(
        buttonToken.connect(userA).setMinUpdateIntervalSec(7200),
      ).to.be.revertedWith('Ownable: caller is not the owner')
    })
  })

  describe('when invoked by owner', function () {
    it('should update minPriceUpdateIntervalSec', async function () {
      expect(await buttonToken.minPriceUpdateIntervalSec()).to.not.eq(7200)
      await buttonToken.connect(deployer).setMinUpdateIntervalSec(7200)
      expect(await buttonToken.minPriceUpdateIntervalSec()).to.eq(7200)
    })
  })
})

describe('ButtonToken:Rebase:Expansion', async () => {
  // Rebase +10%, with starting balances A:750 and B:250.
  let r: any
  before('setup ButtonToken contract', async function () {
    await setupContracts()
    await buttonToken.setMinUpdateIntervalSec(0)

    await mockBTC.connect(deployer).mint(deployerAddress, toFixedPtAmt('1'))
    await mockBTC
      .connect(deployer)
      .approve(buttonToken.address, toFixedPtAmt('1'))

    await buttonToken
      .connect(deployer)
      .mint(await buttonToken.exchangeRate(toFixedPtAmt('1')))
    await buttonToken
      .connect(deployer)
      .transfer(userAAddress, toFixedPtAmt('7500'))
    await buttonToken
      .connect(deployer)
      .transfer(userBAddress, toFixedPtAmt('2500'))

    eqAprox(await buttonToken.totalSupply(), toFixedPtAmt('10000'))
    eqAprox(await buttonToken.balanceOf(deployerAddress), toFixedPtAmt('0'))
    eqAprox(await buttonToken.balanceOf(userAAddress), toFixedPtAmt('7500'))
    eqAprox(await buttonToken.balanceOf(userBAddress), toFixedPtAmt('2500'))

    collateralSupply = await buttonToken.scaledTotalSupply()
    cbA = await buttonToken.scaledBalanceOf(userAAddress)
    cbB = await buttonToken.scaledBalanceOf(userBAddress)

    await mockOracle.setData(toOracleValue('11000'), true)
    r = buttonToken.rebase()
    await r
  })

  it('should emit Rebase', async function () {
    await expect(r)
      .to.emit(buttonToken, 'Rebase')
      .withArgs(toOracleValue('11000'))
  })

  it('should increase the totalSupply', async function () {
    eqAprox(await buttonToken.totalSupply(), toFixedPtAmt('11000'))
  })

  it('should NOT CHANGE the scaledTotalSupply', async function () {
    expect(await buttonToken.scaledTotalSupply()).to.eq(collateralSupply)
  })

  it('should increase individual balances', async function () {
    eqAprox(await buttonToken.balanceOf(userAAddress), toFixedPtAmt('8250'))
    eqAprox(await buttonToken.balanceOf(userBAddress), toFixedPtAmt('2750'))
  })

  it('should NOT CHANGE the individual scaled balances', async function () {
    expect(await buttonToken.scaledBalanceOf(userAAddress)).to.eq(cbA)
    expect(await buttonToken.scaledBalanceOf(userBAddress)).to.eq(cbB)
  })
})

describe('ButtonToken:Rebase:Expansion', async function () {
  const MINT_AMT = toFixedPtAmt('1')
  const MAX_PRICE = ethers.BigNumber.from(2).pow(96).sub(1)
  const MAX_SUPPLY = '792281625142643375935439503363406031780'
  let r: any
  describe('when price is less than MAX_PRICE and expands beyond', function () {
    beforeEach('setup ButtonToken contract', async function () {
      await setupContracts()

      await buttonToken.setMinUpdateIntervalSec(0)

      await mockBTC.connect(deployer).mint(deployerAddress, MINT_AMT)
      await mockBTC.connect(deployer).approve(buttonToken.address, MINT_AMT)
      await buttonToken
        .connect(deployer)
        .mint(await buttonToken.exchangeRate(MINT_AMT))

      await mockOracle.setData(MAX_PRICE.sub(1), true)
      await buttonToken.rebase()
      expect(await buttonToken.currentPrice()).to.eq(MAX_PRICE.sub(1))

      await mockOracle.setData(MAX_PRICE.add(1), true)
      r = buttonToken.connect(deployer).rebase()
      await r
    })

    it('should emit Rebase', async function () {
      await expect(r).to.emit(buttonToken, 'Rebase').withArgs(MAX_PRICE)
    })

    it('should increase the price to MAX_PRICE', async function () {
      expect(await buttonToken.currentPrice()).to.eq(MAX_PRICE)
    })

    it('should increase the supply to MAX_SUPPLY', async function () {
      eqAprox(await buttonToken.totalSupply(), MAX_SUPPLY)
    })
  })

  describe('when totalSupply is MAX_SUPPLY and expands', function () {
    beforeEach('setup ButtonToken contract', async function () {
      await setupContracts()

      await buttonToken.setMinUpdateIntervalSec(0)

      await mockBTC.connect(deployer).mint(deployerAddress, MINT_AMT)
      await mockBTC.connect(deployer).approve(buttonToken.address, MINT_AMT)
      await buttonToken
        .connect(deployer)
        .mint(await buttonToken.exchangeRate(MINT_AMT))

      await mockOracle.setData(MAX_PRICE, true)
      await buttonToken.rebase()

      await mockOracle.setData(MAX_PRICE.add(1), true)
      r = buttonToken.connect(deployer).rebase()
      await r
    })

    it('should emit Rebase', async function () {
      await expect(r).to.emit(buttonToken, 'Rebase').withArgs(MAX_PRICE)
    })

    it('should not change the price', async function () {
      expect(await buttonToken.currentPrice()).to.eq(MAX_PRICE)
    })

    it('should not change the totalSupply', async function () {
      eqAprox(await buttonToken.totalSupply(), MAX_SUPPLY)
    })
  })
})

describe('ButtonToken:Rebase:NoChange', async () => {
  // Rebase +0%, with starting balances A:750 and B:250.
  let r: any
  before('setup ButtonToken contract', async function () {
    await setupContracts()
    await buttonToken.setMinUpdateIntervalSec(0)

    await mockBTC.connect(deployer).mint(deployerAddress, toFixedPtAmt('1'))
    await mockBTC
      .connect(deployer)
      .approve(buttonToken.address, toFixedPtAmt('1'))

    await buttonToken
      .connect(deployer)
      .mint(await buttonToken.exchangeRate(toFixedPtAmt('1')))
    await buttonToken
      .connect(deployer)
      .transfer(userAAddress, toFixedPtAmt('7500'))
    await buttonToken
      .connect(deployer)
      .transfer(userBAddress, toFixedPtAmt('2500'))

    eqAprox(await buttonToken.totalSupply(), toFixedPtAmt('10000'))
    eqAprox(await buttonToken.balanceOf(deployerAddress), toFixedPtAmt('0'))
    eqAprox(await buttonToken.balanceOf(userAAddress), toFixedPtAmt('7500'))
    eqAprox(await buttonToken.balanceOf(userBAddress), toFixedPtAmt('2500'))

    collateralSupply = await buttonToken.scaledTotalSupply()
    cbA = await buttonToken.scaledBalanceOf(userAAddress)
    cbB = await buttonToken.scaledBalanceOf(userBAddress)

    await mockOracle.setData(toOracleValue('10000'), true)
    r = buttonToken.rebase()
    await r
  })

  it('should emit Rebase', async function () {
    await expect(r)
      .to.emit(buttonToken, 'Rebase')
      .withArgs(toOracleValue('10000'))
  })

  it('should not change the totalSupply', async function () {
    eqAprox(await buttonToken.totalSupply(), toFixedPtAmt('10000'))
  })

  it('should NOT CHANGE the scaledTotalSupply', async function () {
    expect(await buttonToken.scaledTotalSupply()).to.eq(collateralSupply)
  })

  it('should not change individual balances', async function () {
    eqAprox(await buttonToken.balanceOf(userAAddress), toFixedPtAmt('7500'))
    eqAprox(await buttonToken.balanceOf(userBAddress), toFixedPtAmt('2500'))
  })

  it('should NOT CHANGE the individual scaled balances', async function () {
    expect(await buttonToken.scaledBalanceOf(userAAddress)).to.eq(cbA)
    expect(await buttonToken.scaledBalanceOf(userBAddress)).to.eq(cbB)
  })
})

describe('ButtonToken:Rebase:Contraction', async () => {
  // Rebase -10%, with starting balances A:750 and B:250.
  let r: any
  before('setup ButtonToken contract', async function () {
    await setupContracts()
    await buttonToken.setMinUpdateIntervalSec(0)

    await mockBTC.connect(deployer).mint(deployerAddress, toFixedPtAmt('1'))
    await mockBTC
      .connect(deployer)
      .approve(buttonToken.address, toFixedPtAmt('1'))

    await buttonToken
      .connect(deployer)
      .mint(await buttonToken.exchangeRate(toFixedPtAmt('1')))
    await buttonToken
      .connect(deployer)
      .transfer(userAAddress, toFixedPtAmt('7500'))
    await buttonToken
      .connect(deployer)
      .transfer(userBAddress, toFixedPtAmt('2500'))

    eqAprox(await buttonToken.totalSupply(), toFixedPtAmt('10000'))
    eqAprox(await buttonToken.balanceOf(deployerAddress), toFixedPtAmt('0'))
    eqAprox(await buttonToken.balanceOf(userAAddress), toFixedPtAmt('7500'))
    eqAprox(await buttonToken.balanceOf(userBAddress), toFixedPtAmt('2500'))

    collateralSupply = await buttonToken.scaledTotalSupply()
    cbA = await buttonToken.scaledBalanceOf(userAAddress)
    cbB = await buttonToken.scaledBalanceOf(userBAddress)

    await mockOracle.setData(toOracleValue('9000'), true)
    r = buttonToken.rebase()
    await r
  })

  it('should emit Rebase', async function () {
    await expect(r)
      .to.emit(buttonToken, 'Rebase')
      .withArgs(toOracleValue('9000'))
  })

  it('should decrease the totalSupply', async function () {
    eqAprox(await buttonToken.totalSupply(), toFixedPtAmt('9000'))
  })

  it('should NOT CHANGE the scaledTotalSupply', async function () {
    expect(await buttonToken.scaledTotalSupply()).to.eq(collateralSupply)
  })

  it('should decrease individual balances', async function () {
    eqAprox(await buttonToken.balanceOf(userAAddress), toFixedPtAmt('6750'))
    eqAprox(await buttonToken.balanceOf(userBAddress), toFixedPtAmt('2250'))
  })

  it('should NOT CHANGE the individual scaled balances', async function () {
    expect(await buttonToken.scaledBalanceOf(userAAddress)).to.eq(cbA)
    expect(await buttonToken.scaledBalanceOf(userBAddress)).to.eq(cbB)
  })
})

describe('ButtonToken:Transfer', function () {
  before('setup ButtonToken contract', async () => {
    await setupContracts()

    await mockBTC.connect(deployer).mint(deployerAddress, toFixedPtAmt('1'))
    await mockBTC
      .connect(deployer)
      .approve(buttonToken.address, toFixedPtAmt('1'))
    await buttonToken
      .connect(deployer)
      .mint(await buttonToken.exchangeRate(toFixedPtAmt('1')))
  })

  describe('deployer transfers 12 to A', function () {
    it('should have correct balances', async function () {
      const deployerBefore = await buttonToken.balanceOf(deployerAddress)
      await buttonToken
        .connect(deployer)
        .transfer(userAAddress, toFixedPtAmt('12'))
      eqAprox(
        await buttonToken.balanceOf(deployerAddress),
        deployerBefore.sub(toFixedPtAmt('12')),
      )
      eqAprox(await buttonToken.balanceOf(userAAddress), toFixedPtAmt('12'))
    })
  })

  describe('deployer transfers 15 to B', async function () {
    it('should have balances [973,15]', async function () {
      const deployerBefore = await buttonToken.balanceOf(deployerAddress)
      await buttonToken
        .connect(deployer)
        .transfer(userBAddress, toFixedPtAmt('15'))
      eqAprox(
        await buttonToken.balanceOf(deployerAddress),
        deployerBefore.sub(toFixedPtAmt('15')),
      )
      eqAprox(await buttonToken.balanceOf(userBAddress), toFixedPtAmt('15'))
    })
  })

  describe('deployer transfers the rest to C', async function () {
    it('should have balances [0,973]', async function () {
      const deployerBefore = await buttonToken.balanceOf(deployerAddress)
      await buttonToken
        .connect(deployer)
        .transfer(await userCAddress, deployerBefore)
      eqAprox(await buttonToken.balanceOf(deployerAddress), '0')
      expect(await buttonToken.balanceOf(await userCAddress)).to.eq(
        deployerBefore,
      )
    })
  })

  describe('when the recipient address is the contract address', function () {
    it('reverts on transfer', async function () {
      await expect(
        buttonToken
          .connect(userA)
          .transfer(buttonToken.address, unitTokenAmount),
      ).to.be.reverted
    })

    it('reverts on transferFrom', async function () {
      await expect(
        buttonToken
          .connect(userA)
          .transferFrom(userAAddress, buttonToken.address, unitTokenAmount),
      ).to.be.reverted
    })
  })

  describe('when the recipient is the zero address', function () {
    it('emits an approval event', async function () {
      await expect(
        buttonToken
          .connect(userA)
          .approve(ethers.constants.AddressZero, transferAmount),
      )
        .to.emit(buttonToken, 'Approval')
        .withArgs(userAAddress, ethers.constants.AddressZero, transferAmount)
    })

    it('transferFrom should fail', async function () {
      await expect(
        buttonToken
          .connect(userC)
          .transferFrom(
            userAAddress,
            ethers.constants.AddressZero,
            unitTokenAmount,
          ),
      ).to.be.reverted
    })
  })
})
