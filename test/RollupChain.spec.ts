import { expect } from 'chai';
import fs from 'fs';
import { ethers } from 'hardhat';

import { keccak256 as solidityKeccak256 } from '@ethersproject/solidity';
import { parseEther } from '@ethersproject/units';
import { Wallet } from '@ethersproject/wallet';

import { deployContracts, getUsers, loadFixture, splitTns } from './common';

describe('RollupChain', function () {
  async function fixture([admin]: Wallet[]) {
    const { registry, rollupChain, strategyDummy, strategyWeth, testERC20, weth } = await deployContracts(admin);

    const tokenAddress = testERC20.address;
    const wethAddress = weth.address;
    await registry.registerAsset(tokenAddress);
    await registry.registerAsset(wethAddress);

    await rollupChain.setNetDepositLimit(tokenAddress, parseEther('10000'));
    await rollupChain.setNetDepositLimit(wethAddress, parseEther('10000'));

    return {
      admin,
      registry,
      rollupChain,
      strategyDummy,
      strategyWeth,
      testERC20,
      weth
    };
  }

  it('should deposit and withdraw ERC20', async function () {
    const { admin, rollupChain, testERC20 } = await loadFixture(fixture);
    const users = await getUsers(admin, [testERC20], 1);
    const tokenAddress = testERC20.address;
    const depositAmount = parseEther('1');
    await testERC20.connect(users[0]).approve(rollupChain.address, depositAmount);
    await expect(rollupChain.connect(users[0]).deposit(tokenAddress, depositAmount))
      .to.emit(rollupChain, 'AssetDeposited')
      .withArgs(users[0].address, 1, depositAmount, 0);

    const [dhash, blockID, status] = await rollupChain.pendingDeposits(0);
    const h = solidityKeccak256(['address', 'uint32', 'uint256'], [users[0].address, 1, depositAmount]);
    expect(dhash).to.equal(h);
    expect(blockID).to.equal(0);
    expect(status).to.equal(0);

    const withdrawAmount = parseEther('1');
    await expect(rollupChain.connect(users[0]).withdraw(users[0].address, tokenAddress)).to.be.revertedWith(
      'Nothing to withdraw'
    );

    const txs = fs.readFileSync('test/input/data/rollup/dep-wd-tk1-tn').toString().split('\n');
    await rollupChain.commitBlock(0, txs);

    const [account, assetID, amount] = await rollupChain.pendingWithdrawCommits(0, 0);
    expect(account).to.equal(users[0].address);
    expect(assetID).to.equal(1);
    expect(amount).to.equal(withdrawAmount);

    await rollupChain.executeBlock([]);

    const totalAmount = await rollupChain.pendingWithdraws(users[0].address, assetID);
    expect(assetID).to.equal(1);
    expect(totalAmount).to.equal(withdrawAmount);

    const balanceBefore = await testERC20.balanceOf(users[0].address);
    await rollupChain.withdraw(users[0].address, tokenAddress);
    const balanceAfter = await testERC20.balanceOf(users[0].address);
    expect(balanceAfter.sub(balanceBefore)).to.equal(withdrawAmount);
  });

  it('should deposit and withdraw ETH', async function () {
    const { admin, rollupChain, weth } = await loadFixture(fixture);
    const users = await getUsers(admin, [], 1);
    const wethAddress = weth.address;
    const depositAmount = parseEther('1');
    await expect(
      rollupChain.connect(users[0]).depositETH(wethAddress, depositAmount, {
        value: depositAmount
      })
    )
      .to.emit(rollupChain, 'AssetDeposited')
      .withArgs(users[0].address, 2, depositAmount, 0);

    const [dhash, blockID, status] = await rollupChain.pendingDeposits(0);
    const h = solidityKeccak256(['address', 'uint32', 'uint256'], [users[0].address, 2, depositAmount]);
    expect(dhash).to.equal(h);
    expect(blockID).to.equal(0);
    expect(status).to.equal(0);

    const txs = fs.readFileSync('test/input/data/rollup/dep-wd-tk2-tn').toString().split('\n');
    await rollupChain.commitBlock(0, txs);
    expect(await rollupChain.getCurrentBlockId()).to.equal(0);

    const [account, assetID, amount] = await rollupChain.pendingWithdrawCommits(0, 0);
    expect(account).to.equal(users[0].address);
    expect(assetID).to.equal(2);
    expect(amount).to.equal(depositAmount);

    await rollupChain.executeBlock([]);

    const totalAmount = await rollupChain.pendingWithdraws(users[0].address, assetID);
    expect(assetID).to.equal(2);
    expect(totalAmount).to.equal(depositAmount);

    const balanceBefore = await ethers.provider.getBalance(users[0].address);
    const withdrawTx = await rollupChain.connect(users[0]).withdrawETH(users[0].address, weth.address);
    const gasSpent = (await withdrawTx.wait()).gasUsed.mul(withdrawTx.gasPrice);
    const balanceAfter = await ethers.provider.getBalance(users[0].address);
    expect(balanceAfter.sub(balanceBefore).add(gasSpent)).to.equal(depositAmount);
  });

  it('should commit and execute blocks with sync commitment transitions', async function () {
    const { admin, registry, rollupChain, strategyDummy, strategyWeth, testERC20, weth } = await loadFixture(fixture);
    await registry.registerStrategy(strategyDummy.address);
    await registry.registerStrategy(strategyWeth.address);

    const users = await getUsers(admin, [testERC20], 1);
    await testERC20.connect(users[0]).approve(rollupChain.address, parseEther('4'));
    await rollupChain.connect(users[0]).deposit(testERC20.address, parseEther('4'));
    await rollupChain.connect(users[0]).depositETH(weth.address, parseEther('4'), {
      value: parseEther('4')
    });

    const tnData = fs.readFileSync('test/input/data/rollup/sync-commit-tn').toString().split('\n');
    const tns = await splitTns(tnData);

    await rollupChain.commitBlock(0, tns[0]);
    let intents = [tns[0][4], tns[0][7]];
    expect(await rollupChain.executeBlock(intents))
      .to.emit(rollupChain, 'RollupBlockExecuted')
      .withArgs(0);

    expect(await strategyDummy.syncBalance()).to.equal(parseEther('2'));
    expect(await strategyWeth.syncBalance()).to.equal(parseEther('3'));

    await rollupChain.commitBlock(1, tns[1]);
    intents = [tns[1][3], tns[1][4]];
    await rollupChain.executeBlock(intents);

    expect(await strategyDummy.syncBalance()).to.equal(parseEther('1'));
    expect(await strategyWeth.syncBalance()).to.equal(parseEther('1'));
  });

  it('should commit and execute blocks with deposit and sync balance transitions', async function () {
    const { admin, registry, rollupChain, strategyDummy, strategyWeth, testERC20, weth } = await loadFixture(fixture);
    await registry.registerStrategy(strategyDummy.address);
    await registry.registerStrategy(strategyWeth.address);

    const users = await getUsers(admin, [testERC20], 2);
    await testERC20.connect(users[0]).approve(rollupChain.address, parseEther('100'));
    await testERC20.connect(users[1]).approve(rollupChain.address, parseEther('100'));
    await rollupChain.connect(users[0]).deposit(testERC20.address, parseEther('1'));
    await rollupChain.connect(users[1]).depositETH(weth.address, parseEther('2'), {
      value: parseEther('2')
    });
    await rollupChain.connect(users[1]).deposit(testERC20.address, parseEther('3'));
    await rollupChain.connect(users[0]).depositETH(weth.address, parseEther('4'), {
      value: parseEther('4')
    });

    let [dhash, blockID, status] = await rollupChain.pendingDeposits(0);
    let h = solidityKeccak256(['address', 'uint32', 'uint256'], [users[0].address, 1, parseEther('1')]);
    expect(dhash).to.equal(h);
    expect(blockID).to.equal(0);
    expect(status).to.equal(0);

    [dhash, blockID, status] = await rollupChain.pendingDeposits(1);
    h = solidityKeccak256(['address', 'uint32', 'uint256'], [users[1].address, 2, parseEther('2')]);
    expect(dhash).to.equal(h);
    expect(blockID).to.equal(0);
    expect(status).to.equal(0);

    [dhash, blockID, status] = await rollupChain.pendingDeposits(2);
    h = solidityKeccak256(['address', 'uint32', 'uint256'], [users[1].address, 1, parseEther('3')]);
    expect(dhash).to.equal(h);
    expect(blockID).to.equal(0);
    expect(status).to.equal(0);

    [dhash, blockID, status] = await rollupChain.pendingDeposits(3);
    h = solidityKeccak256(['address', 'uint32', 'uint256'], [users[0].address, 2, parseEther('4')]);
    expect(dhash).to.equal(h);
    expect(blockID).to.equal(0);
    expect(status).to.equal(0);

    await strategyDummy.harvest();
    await rollupChain.syncBalance(1);
    await strategyDummy.harvest();
    await rollupChain.syncBalance(1);
    await strategyWeth.harvest();
    await strategyWeth.harvest();
    await rollupChain.syncBalance(2);

    let bhash;
    [bhash, blockID, status] = await rollupChain.pendingBalanceSyncs(0);
    h = solidityKeccak256(['uint32', 'uint256'], [1, parseEther('1')]);
    expect(bhash).to.equal(h);
    expect(blockID).to.equal(0);
    expect(status).to.equal(0);

    [bhash, blockID, status] = await rollupChain.pendingBalanceSyncs(1);
    h = solidityKeccak256(['uint32', 'uint256'], [1, parseEther('1')]);
    expect(bhash).to.equal(h);
    expect(blockID).to.equal(0);
    expect(status).to.equal(0);

    [bhash, blockID, status] = await rollupChain.pendingBalanceSyncs(2);
    h = solidityKeccak256(['uint32', 'uint256'], [2, parseEther('2')]);
    expect(bhash).to.equal(h);
    expect(blockID).to.equal(0);
    expect(status).to.equal(0);

    const tnData = fs.readFileSync('test/input/data/rollup/dep-syncbal-tn').toString().split('\n');
    const tns = await splitTns(tnData);

    await expect(rollupChain.commitBlock(0, tns[1])).to.be.revertedWith(
      'invalid balance sync transition, mismatch or wrong ordering'
    );

    await rollupChain.commitBlock(0, tns[0]);

    [, , status] = await rollupChain.pendingDeposits(2);
    expect(status).to.equal(1);
    [, , status] = await rollupChain.pendingDeposits(3);
    expect(status).to.equal(0);
    [, , status] = await rollupChain.pendingBalanceSyncs(0);
    expect(status).to.equal(1);
    [, , status] = await rollupChain.pendingBalanceSyncs(1);
    expect(status).to.equal(0);

    await rollupChain.commitBlock(1, tns[1]);

    [, , status] = await rollupChain.pendingDeposits(3);
    expect(status).to.equal(1);
    [, , status] = await rollupChain.pendingBalanceSyncs(2);
    expect(status).to.equal(1);

    await expect(rollupChain.executeBlock([])).to.emit(rollupChain, 'RollupBlockExecuted').withArgs(0);

    [dhash, blockID, status] = await rollupChain.pendingDeposits(2);
    expect(dhash).to.equal('0x0000000000000000000000000000000000000000000000000000000000000000');
    expect(blockID).to.equal(0);
    expect(status).to.equal(0);

    [dhash, blockID, status] = await rollupChain.pendingDeposits(3);
    h = solidityKeccak256(['address', 'uint32', 'uint256'], [users[0].address, 2, parseEther('4')]);
    expect(dhash).to.equal(h);
    expect(blockID).to.equal(1);
    expect(status).to.equal(1);

    [bhash, blockID, status] = await rollupChain.pendingBalanceSyncs(0);
    expect(bhash).to.equal('0x0000000000000000000000000000000000000000000000000000000000000000');
    expect(blockID).to.equal(0);
    expect(status).to.equal(0);

    [bhash, blockID, status] = await rollupChain.pendingBalanceSyncs(1);
    h = solidityKeccak256(['uint32', 'uint256'], [1, parseEther('1')]);
    expect(bhash).to.equal(h);
    expect(blockID).to.equal(1);
    expect(status).to.equal(1);

    await expect(rollupChain.executeBlock([])).to.emit(rollupChain, 'RollupBlockExecuted').withArgs(1);

    [dhash, blockID, status] = await rollupChain.pendingDeposits(3);
    expect(dhash).to.equal('0x0000000000000000000000000000000000000000000000000000000000000000');
    expect(blockID).to.equal(0);
    expect(status).to.equal(0);

    [bhash, blockID, status] = await rollupChain.pendingBalanceSyncs(2);
    expect(bhash).to.equal('0x0000000000000000000000000000000000000000000000000000000000000000');
    expect(blockID).to.equal(0);
    expect(status).to.equal(0);
  });
});
