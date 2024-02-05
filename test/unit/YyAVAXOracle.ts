import { expect } from 'chai'
import { BigNumber } from 'ethers'
import { ethers, waffle } from 'hardhat'

async function mockedOracle() {
  const [deployer, user] = await ethers.getSigners()
  // deploy mocks
  const mockYyAVAX = await (await ethers.getContractFactory('MockYyAVAX'))
    .connect(deployer)
    .deploy()
  // deploy contract to test
  const oracle = await (await ethers.getContractFactory('YyAVAXOracle'))
    .connect(deployer)
    .deploy(mockYyAVAX.address)
  // need a contract with a non-view method that calls oracle.getData so we can gas test
  const mockOracleDataFetcher = await (
    await ethers.getContractFactory('MockOracleDataFetcher')
  )
    .connect(deployer)
    .deploy(oracle.address)

  return {
    deployer,
    user,
    mockYyAVAX,
    oracle,
    mockOracleDataFetcher,
  }
}

describe('YyAVAXOracle', function () {
  describe('when sent ether', async function () {
    it('should reject', async function () {
      const { user, oracle } = await waffle.loadFixture(mockedOracle)
      await expect(user.sendTransaction({ to: oracle.address, value: 1 })).to.be
        .reverted
    })
  })

  describe('Fetching data', async function () {
    it('should succeed with fresh data', async function () {
      const { user, mockYyAVAX, mockOracleDataFetcher } =
        await waffle.loadFixture(mockedOracle)

      await expect(
        mockYyAVAX
          .connect(user)
          .setTotalShares(BigNumber.from('6413278131285121422182816')),
      ).to.not.be.reverted
      await expect(
        mockYyAVAX
          .connect(user)
          .setTotalAssets(BigNumber.from('7091831834635293267033248')),
      ).to.not.be.reverted

      const tx = await mockOracleDataFetcher.connect(user).fetch()
      const receipt = await tx.wait()
      const [value, valid] = await mockOracleDataFetcher.getData()

      // yyAVAX denominated in AVAX should be totalShares/totalAssets
      expect(value.toString()).to.eq('1105804502698871756')
      expect(valid).to.eq(true)
      expect(receipt.gasUsed.toString()).to.equal('78523')
    })
  })
})
