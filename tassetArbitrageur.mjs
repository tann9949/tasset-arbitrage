import { ethers } from 'ethers'
import { config } from 'dotenv'
import fetch from 'node-fetch'

import { ABI } from './abi.mjs'
import { addresses } from './address.mjs'

config()


export class TAssetArbitrageur {

    constructor(provider, tasset, threshold, slippage) {
        this.provider = provider;
        this.wallet = new ethers.Wallet.fromMnemonic(process.env.SEED)
        this.wallet = this.wallet.connect(this.provider)

        this.threshold = threshold  // abt threshold default 11
        this.slippage = slippage  // max slippage 1%
        this.deadline = 5 // in minutes
        this.gasPrice = 5  // gwei
        
        this.twindexSwapFee = 0.003
        this.twindexMintFee = 0.00
        this.twindexRedeemFee = 0.003
        this.tasset = tasset
        this.buffer = 0.995

        this.contract = this.initContract()

        this.totalGasSpend = 0.  // in BNB
    }

    initContract() {
        return {
            oracle: {
                kusd: new ethers.Contract(addresses.oracle.kusd, ABI.oracle.kusd, this.provider),
                twx: new ethers.Contract(addresses.oracle.twx, ABI.oracle.kusd, this.provider),
            },
            token: { 
                kusd: new ethers.Contract(addresses.stablecoin.kusd, ABI.token.kusd, this.provider),
                twx: new ethers.Contract(addresses.token.twx, ABI.token.kusd, this.provider),
            },
            twindex: { 
                router: new ethers.Contract(addresses.twindex.router, ABI.twindex.router, this.wallet),
                swap: new ethers.Contract(addresses.twindex.swap, ABI.twindex.swap, this.wallet) 
            },
            quickMint: new ethers.Contract(addresses.twindex.quickMint, ABI.twindex.quickMint, this.wallet),
            syntheticController: new ethers.Contract(addresses.twindex.synthController, ABI.tasset.controller, this.wallet),
            twindexRouter: new ethers.Contract(addresses.twindex.router, ABI.twindex.router, this.wallet),
            tasset: {
                token: new ethers.Contract(addresses.tassets[this.tasset].token, ABI.tasset.token, this.provider),
                swap: new ethers.Contract(addresses.tassets[this.tasset].lp, ABI.tasset.lp, this.wallet),
                synthPool: new ethers.Contract(addresses.tassets[this.tasset].synthPool, ABI.tasset.synthPool, this.wallet),
                linkOracle: new ethers.Contract(addresses.tassets[this.tasset].oracle, ABI.tasset.oracle, this.provider)
            }
        }
    }

    async computeDiscountPnL(positionSize) {
        const oraclePrice = await this.getOraclePrice()
        const swapPrice = await this.getTAssetSwapPrice()

        let expectedKusd = 0.
        let receivedKusd = 0.
        let totalFee = 0.
        
        //// SWAP
        console.log(`\n>>>Swapping ${positionSize} KUSD to ${this.tasset}`)
        const exactSynthOut = (await this.contract.twindex.router.getAmountsOut(
            ethers.utils.parseEther(positionSize.toString()),
            [
                this.contract.token.kusd.address,
                this.contract.tasset.token.address
            ]
        ))[1]
        const synthOut = exactSynthOut / 1e18
        const expectSynthOut = (positionSize * (1. - this.twindexSwapFee)) / swapPrice
        const synthSlippage = (synthOut - expectSynthOut) * 100 / expectSynthOut
        const synthSlippageFmt = synthSlippage > 0 ? `+${synthSlippage.toFixed(2)}` : `${synthSlippage.toFixed(2)}`
        const kusdFee = positionSize * this.twindexSwapFee

        console.log(`Expect to receive ${expectSynthOut} ${this.tasset}`)
        console.log(`TAsset received: ${synthOut} ${this.tasset} (${synthSlippageFmt}%)`)
        console.log(`Swap Fee: ${kusdFee} KUSD`)
        expectedKusd += expectSynthOut * oraclePrice
        totalFee += kusdFee

        // REDEEM
        console.log(`\n>>>Redeeming ${synthOut} ${this.tasset}`)
        const synthAmount = exactSynthOut * 0.9999 / 1e18;

        const ecr = await this.contract.syntheticController.getECR() / 1e18;
        const sharePrice = await this.contract.syntheticController.getSharePrice() / 1e18  // twx price
        const synthPrice = await this.contract.tasset.synthPool.getSynthPrice() / 1e18  // synth price
        const collateralPrice = await this.contract.tasset.synthPool.getCollateralPrice() / 1e18  // kusd price
        
        const synthAmountPostFees = synthAmount * (1. - this.twindexRedeemFee)  // redeemable unit
        const synthDollarValue = synthAmountPostFees * synthPrice
        const synthFee = synthAmount * (this.twindexRedeemFee)
        const synthDollarFee = synthFee * oraclePrice

        const shareReceived = synthDollarValue * (1. - ecr) / sharePrice
        const collateralReceived = synthDollarValue * ecr / collateralPrice

        const twxOracleDiff = (sharePrice - this.twxPrice) * 100 / this.twxPrice
        const twxDiffFmt = twxOracleDiff > 0 ? `+${twxOracleDiff}` : twxOracleDiff
        console.log(`TWX swap price: ${this.twxPrice} KUSD`)
        console.log(`TWX oracle price: ${sharePrice} KUSD (${twxDiffFmt}%)\n`)

        console.log(`KUSD received: ${collateralReceived} KUSD`)
        console.log(`TWX received: ${shareReceived} TWX`)
        console.log(`Redeem Fee: ${synthFee} ${this.tasset} (${synthDollarFee} KUSD)`)
        receivedKusd += collateralReceived
        totalFee += synthDollarFee

        // swap twx
        console.log(`\n>>>Swapping ${shareReceived} TWX to KUSD`)
        const exactKusdOut = (await this.contract.twindex.router.getAmountsOut(
            ethers.utils.parseEther(shareReceived.toString()),
            [
                this.contract.token.twx.address,
                this.contract.token.kusd.address,
            ]
        ))[1]
        const kusdOut = exactKusdOut / 1e18
        const expectKusdOut = (shareReceived * (1. - this.twindexSwapFee)) * sharePrice
        const kusdSlippage = (kusdOut - expectKusdOut) * 100 / expectKusdOut
        const kusdSlippageFmt = kusdSlippage > 0 ? `+${kusdSlippage.toFixed(4)}` : `${kusdSlippage.toFixed(4)}`
        const twxFee = shareReceived * this.twindexSwapFee
        const twxDollarFee = twxFee * this.twxPrice

        console.log(`Expect to receive ${expectKusdOut} KUSD`)
        console.log(`KUSD received: ${kusdOut} KUSD (${kusdSlippageFmt}%)`)
        console.log(`Swap Fee: ${twxFee} TWX (${twxDollarFee} KUSD)`)
        receivedKusd += kusdOut
        totalFee += twxDollarFee

        const diff = receivedKusd - expectedKusd
        const diffPct = (receivedKusd - expectedKusd) * 100 / expectedKusd

        const balanceDiff = receivedKusd - positionSize
        const balanceDiffPct = balanceDiff * 100 / positionSize

        const diffFmt = diff > 0 ? `+${diff.toFixed(2)}` : diff.toFixed(2)
        const diffPctFmt = diffPct > 0 ? `+${diffPct.toFixed(2)}` : diffPct.toFixed(2)
        const balanceDiffFmt = balanceDiff > 0 ? `+${balanceDiff.toFixed(2)}` : balanceDiff.toFixed(2)
        const balanceDiffPctFmt = balanceDiffPct > 0 ? `+${balanceDiffPct.toFixed(2)}` : balanceDiffPct.toFixed(2)
        console.log(`\n>>>Summary`)
        console.log(`Expected KUSD Balance: ${expectedKusd} KUSD`)
        console.log(`Actual KUSD Balance: ${receivedKusd} KUSD (${diffFmt}%)`)
        console.log(`    ${diffFmt} KUSD (${diffPctFmt}%) from expected`)
        console.log(`    ${balanceDiffFmt} KUSD (${balanceDiffPctFmt}%) from this txn`)
        console.log(`Total Fee Paid: ${totalFee} KUSD`)
    }

    async computePremiumPnL(positionSize) {
        const swapPrice = await this.getTAssetSwapPrice()
        const collateralAmount = positionSize

        let expectedKusd = 0.
        let receivedKusd = 0.
        let totalFee = 0.

        // QUICK MINT (no mint fee)+console.log(`Collateral Ratio: ${(tcr*100).toFixed(2)}%`)
        const offset = 0.005  // offset depends on slippage
        const tcr = await this.contract.syntheticController.globalCollateralRatio() / 1e18
        const collateralPrice = await this.contract.oracle.kusd.consult(
            this.contract.token.kusd.address,
            ethers.utils.parseEther("1")
        ) / 1e18  // KUSD Oracle price

        const collateralValue = collateralAmount * collateralPrice
        const swapCollateralAmount = collateralValue * (1. - tcr + offset) / collateralPrice
        const remainCollateralAmount = collateralAmount - swapCollateralAmount

        console.log(`\nCollateral Amount: ${remainCollateralAmount} KUSD`)
        console.log(`Share Amount to be swapped to TWX: ${swapCollateralAmount} KUSD`)

        //// SWAP TO TWX FOR COLLATERAL
        console.log(`\n>>>[Quick Mint]Swapping ${swapCollateralAmount} KUSD`)
        const kusdFee = swapCollateralAmount * this.twindexSwapFee
        const receivedAmounts = await this.contract.twindex.router.getAmountsOut(
            ethers.utils.parseEther(swapCollateralAmount.toString()),
            [
                this.contract.token.kusd.address,
                this.contract.token.twx.address,
            ],
        )
        const expectedActualAmount = swapCollateralAmount / this.twxPrice  // should have got if compute price directly
        const twxActualAmount = receivedAmounts[receivedAmounts.length - 1] / 1e18  // price including slippage

        const twxSlippage = (twxActualAmount - expectedActualAmount) * 100 / expectedActualAmount
        const twxSlippageFmt = twxSlippage > 0 ? `+${twxSlippage.toFixed(2)}` : `${twxSlippage.toFixed(2)}`
        totalFee += kusdFee

        console.log(`Expect to receive ${expectedActualAmount} TWX`)
        console.log(`TWX received: ${twxActualAmount} TWX (${twxSlippageFmt}%)`)
        console.log(`Swap Fee: ${kusdFee} KUSD`)

        // swapCollateralAmount KUSD -> twxActualAmount TWX

        //// MINT TAsset
        console.log(`\n>>>[Quick Mint]Minting ${this.tasset} with (${remainCollateralAmount} KUSD + ${twxActualAmount} TWX)`)
        
        const sharePrice = await this.contract.syntheticController.getSharePrice() / 1e18  // oracle TWX price
        const synthPrice = await this.contract.tasset.synthPool.getSynthPrice() / 1e18
        const globalCollateralRatio = tcr
        
        const twxOracleDiff = (sharePrice - this.twxPrice) * 100 / this.twxPrice
        const twxDiffFmt = twxOracleDiff > 0 ? `+${twxOracleDiff}` : twxOracleDiff
        console.log(`TWX swap price: ${this.twxPrice} KUSD`)
        console.log(`TWX oracle price: ${sharePrice} KUSD (${twxDiffFmt}%)\n`)

        const collateralValueKusd = remainCollateralAmount * collateralPrice
        // globalCollateralRatio * synthPrice = collateralValueKusd  ----(1)
        // (1. - globalCollateralRatio) * synthPrice = shareNeeded * sharePrice ----(2)
        // collateralValueKusd / globalCollateralRatio = shareNeeded * sharePrice / (1. - globalCollateralRatio)   ---- from (1) and (2)
        // shareNeeded = globalCollateralValueKusd * (1. - globalCollateralRatio) / globalCollateralRatio * sharePrice
        const shareNeeded = (1. - globalCollateralRatio) * collateralValueKusd / (globalCollateralRatio * sharePrice)

        console.log(`shareNeeded: ${shareNeeded} TWX`)
        console.log(`swappedShare: ${twxActualAmount} TWX`)

        if (shareNeeded > twxActualAmount) {
            throw new Error("shareNeeded less than swappedShare")
        }
        console.log(`** Excess TWX: ${twxActualAmount - shareNeeded} TWX`)

        const totalDepositValue = collateralValueKusd + (shareNeeded * sharePrice)
        const synthAmount = totalDepositValue / synthPrice
        
        const synthAmountReceive = synthAmount * (1. - this.twindexMintFee)
        const mintFee = (synthAmount - synthAmountReceive) * synthPrice
        totalFee += mintFee

        console.log(`Received ${synthAmountReceive} ${this.tasset}`)
        console.log(`Mint Fee: ${mintFee} KUSD`)

        // SWAP TASSET
        console.log(`\n>>>Swapping ${synthAmountReceive} ${this.tasset}`)
        const exactKusdOut = (await this.contract.twindex.router.getAmountsOut(
            ethers.utils.parseEther(synthAmountReceive.toString()),
            [
                this.contract.tasset.token.address,
                this.contract.token.kusd.address,
            ]
        ))[1]
        const kusdOut = exactKusdOut / 1e18
        const expectKusdOut = (synthAmountReceive * (1. - this.twindexSwapFee)) * swapPrice
        const kusdSlippage = (kusdOut - expectKusdOut) * 100 / expectKusdOut
        const kusdSlippageFmt = kusdSlippage > 0 ? `+${kusdSlippage.toFixed(2)}` : `${kusdSlippage.toFixed(2)}`
        const tassetFee = synthAmountReceive * this.twindexSwapFee * synthPrice
        totalFee += tassetFee
        receivedKusd += kusdOut
        expectedKusd += expectKusdOut

        console.log(`Expect to receive ${expectKusdOut} KUSD`)
        console.log(`KUSD received: ${kusdOut} KUSD (${kusdSlippageFmt}%)`)
        console.log(`Swap Fee: ${tassetFee} KUSD`)

        const diff = receivedKusd - expectedKusd
        const diffPct = (receivedKusd - expectedKusd) * 100 / expectedKusd

        const balanceDiff = receivedKusd - positionSize
        const balanceDiffPct = balanceDiff * 100 / positionSize

        const diffFmt = diff > 0 ? `+${diff.toFixed(2)}` : diff.toFixed(2)
        const diffPctFmt = diffPct > 0 ? `+${diffPct.toFixed(2)}` : diffPct.toFixed(2)
        const balanceDiffFmt = balanceDiff > 0 ? `+${balanceDiff.toFixed(2)}` : balanceDiff.toFixed(2)
        const balanceDiffPctFmt = balanceDiffPct > 0 ? `+${balanceDiffPct.toFixed(2)}` : balanceDiffPct.toFixed(2)
        console.log(`\n>>>Summary`)
        console.log(`Expected KUSD Balance: ${expectedKusd} KUSD`)
        console.log(`Actual KUSD Balance: ${receivedKusd} KUSD (${diffFmt}%)`)
        console.log(`    ${diffFmt} KUSD (${diffPctFmt}%) from expected`)
        console.log(`    ${balanceDiffFmt} KUSD (${balanceDiffPctFmt}%) from this txn`)
        console.log(`Total Fee Paid: ${totalFee} KUSD`)
    }

    async getPancakePrice(address) {
        const response = await fetch(
            `https://api.pancakeswap.info/api/v2/tokens/${address}`,
            { "method": "GET" }
        )
        return response.json();
    }

    async getTAssetSwapPrice() {
        const contract = this.contract.tasset.swap
        const token0 = await contract.token0()
        const [token0Reserve, token1Reserve] = await contract.getReserves()

        return token0 === addresses.stablecoin.kusd ? token0Reserve / token1Reserve : token1Reserve / token0Reserve
    }

    async getTwxReserves() {
        const contract = this.contract.twindex.swap
        const token0 = await contract.token0()
        const [token0Reserve, token1Reserve] = await contract.getReserves()

        return token0 === addresses.stablecoin.kusd ? {
            twx: token1Reserve,
            kusd: token0Reserve
        } : {
            kusd: token1Reserve,
            twx: token0Reserve
        }
    }

    async getReserves() {
        const contracts = this.contract.tasset.swap
        const token0 = await contracts.token0()
        const [token0Reserve, token1Reserve] = await contracts.getReserves()

        if (token0 === addresses.stablecoin.kusd) {
            // token0 = kusd, token1 = tasset
            return {
                kusd: token0Reserve,
                tasset: token1Reserve
            }
        } else {
            // token1 = kusd, token0 = tasset
            return {
                tasset: token0Reserve,
                kusd: token1Reserve
            }
        }
    }

    async getOraclePrice() {
        return await this.contract.tasset.token.getSynthPrice() / 1e18
    }

    async swapKUSDToTAsset(positionSize, reserve) {
        // define deadline
        const deadline = + new Date() + this.deadline * 60
        // get amountIn from positionSize, and path
        let amountIn = ethers.utils.parseEther(positionSize.toString())  // in wei
        // calculate amountOutMin
        const amountInWithFee = positionSize * (1. - this.twindexSwapFee) * 1e18  // defuct twindex fee 0.3%
        const numerator = amountInWithFee * reserve.tasset
        const denominator = + reserve.kusd + amountInWithFee
        const amountOut = numerator / denominator
        const amountOutMin = ethers.utils.parseEther((amountOut * (1. - this.slippage) / 1e18).toString()) // in wei
        // routing path and wallet address
        const path = [this.contract.token.kusd.address, this.contract.tasset.token.address]
        const to = this.wallet.address

        const gasLimit = await this.contract.twindexRouter.estimateGas.swapExactTokensForTokens(
            amountIn,
            amountOutMin,
            path,
            to,
            deadline
        )

        const kusdBeforeSwap = await this.contract.token.kusd.balanceOf(this.wallet.address) / 1e18;
        const tassetBeforeSwap = await this.contract.tasset.token.balanceOf(this.wallet.address) / 1e18
        
        const option = {
            gasPrice: ethers.utils.parseUnits(this.gasPrice.toString(), "gwei"),
            gasLimit: gasLimit.toString(),
        }
        
        console.log(`>>>>>>>>>>SWAPPING KUSD TO ${this.tasset}`)
        console.log(`> Swapping [${(amountIn / 1e18).toFixed(4)} KUSD] for [${(amountOut / 1e18).toFixed(4)} ${this.tasset}] (Slippage ${this.slippage*100}%)`)

        const tx = await this.contract.twindexRouter.swapExactTokensForTokens(
            amountIn,
            amountOutMin,
            path,
            to,
            deadline,
            option
        )
        const txReceipt = await tx.wait()

        const tassetAfterSwap = await this.contract.tasset.token.balanceOf(this.wallet.address) / 1e18
        const kusdAfterSwap = await this.contract.token.kusd.balanceOf(this.wallet.address) / 1e18;
        const kusdSpend = kusdBeforeSwap - kusdAfterSwap
        const tassetReceived = tassetAfterSwap - tassetBeforeSwap
        const gasSpent = ((this.gasPrice * 1e9) * (txReceipt.gasUsed)) / 1e18  // in BNB
        this.totalGasSpend += gasSpent
            
        console.log(`Swapped [${kusdSpend.toFixed(4)} KUSD] for [${tassetReceived.toFixed(4)} ${this.tasset}]`)
        console.log(`Gas Fee used: ${gasSpent.toFixed(6)} BNB (${(gasSpent * this.bnbPrice).toFixed(2)} USD)`)
    }

    async swapTAssetToKUSD(reserve) {
        // define deadline
        const deadline = + new Date() + this.deadline * 60
        // get amountIn from positionSize, and path
        let amountIn = await this.contract.tasset.token.balanceOf(this.wallet.address) * 0.999 / 1e18
        // calculate amountOutMin
        const amountInWithFee = amountIn * (1. - this.twindexSwapFee) * 1e18  // defuct twindex fee 0.3%, unit in wei
        const numerator = amountInWithFee * reserve.kusd
        const denominator = + reserve.tasset + amountInWithFee
        const amountOut = numerator / denominator
        const amountOutMin = ethers.utils.parseEther((amountOut * (1. - this.slippage) / 1e18).toString()) // in wei
        // routing path and wallet address
        const path = [this.contract.tasset.token.address, this.contract.token.kusd.address]
        const to = this.wallet.address

        const _amountIn = ethers.utils.parseEther(amountIn.toString())
        const gasLimit = await this.contract.twindexRouter.estimateGas.swapExactTokensForTokens(
            _amountIn,
            amountOutMin,
            path,
            to,
            deadline
        )

        const option = {
            gasPrice: ethers.utils.parseUnits(this.gasPrice.toString(), "gwei"),
            gasLimit: gasLimit.toString(),
        }

        const kusdBeforeSwap = await this.contract.token.kusd.balanceOf(this.wallet.address) / 1e18;
        const tassetBeforeSwap = await this.contract.tasset.token.balanceOf(this.wallet.address) / 1e18
        
        console.log(`>>>>>>>>>>SWAPPING ${this.tasset} to KUSD`)
        console.log(`> Swapping [${(amountIn / 1e18).toFixed(4)} ${this.tasset}] for [${(amountOut / 1e18).toFixed(4)} KUSD] (Slippage ${this.slippage*100}%)`)
        
        const tx = await this.contract.twindexRouter.swapExactTokensForTokens(
            _amountIn,
            amountOutMin,
            path,
            to,
            deadline,
            option
        )
        
        const txReceipt = await tx.wait()
        
        const tassetAfterSwap = await this.contract.tasset.token.balanceOf(this.wallet.address) / 1e18
        const kusdAfterSwap = await this.contract.token.kusd.balanceOf(this.wallet.address) / 1e18;
        const kusdReceived = kusdAfterSwap - kusdBeforeSwap
        const tassetSpent = tassetBeforeSwap - tassetAfterSwap
        const gasSpent = ((this.gasPrice * 1e9) * (txReceipt.gasUsed)) / 1e18  // in BNB
        this.totalGasSpend += gasSpent
        
        console.log(`Swapped [${kusdReceived} KUSD] for [${tassetSpent.toFixed(4)} ${this.tasset}]`)
        console.log(`Gas Fee used: ${gasSpent.toFixed(6)} BNB (${(gasSpent * this.bnbPrice).toFixed(2)} USD)`)
    }
        
    async mintTAsset(amountIn) {
        const oraclePrice = await this.getOraclePrice();
        const amountInWithFee = amountIn * (1. - this.twindexMintFee)
        const collateralRatio = await this.contract.syntheticController.globalCollateralRatio() / 1e18
        
        const synthOut = amountInWithFee / oraclePrice
        const swapShare = amountInWithFee * (1. - collateralRatio)
        
        const collateralAmount = ethers.utils.parseEther(amountIn.toString());  // * 1e18
        const swapShareOutMin = ethers.utils.parseEther((swapShare * (1. - this.slippage)).toString());
        const offset = ethers.utils.parseEther("0.005");
        const synthOutMin = ethers.utils.parseEther((synthOut * (1. - this.slippage)).toString());
        
        const gasLimit = await this.contract.quickMint.estimateGas.quickMint(
            this.contract.tasset.synthPool.address,
            collateralAmount,
            swapShareOutMin,
            offset,
            synthOutMin
        )
        const gasFee = ((this.gasPrice * 1e9) * gasLimit) / 1e18  // canvert gasPrice to wei, and gasFee to Ether (BNB)
        this.gasPrice += gasFee;
        
        const option = {
            gasPrice: ethers.utils.parseUnits(this.gasPrice.toString(), "gwei"),
            gasLimit: gasLimit.toString(),
        }
        
        const kusdBeforeSwap = await this.contract.token.kusd.balanceOf(this.wallet.address) / 1e18;
        const tassetBeforeSwap = await this.contract.tasset.token.balanceOf(this.wallet.address) / 1e18

        console.log(`>>>>>>>>>>QUICK MINTING KUSD TO ${this.tasset}`)
        console.log(`> Quick Mint [${synthOut.toFixed(4)} ${this.tasset}] with [${(collateralAmount / 1e18).toFixed(4)} KUSD] (Slippage ${this.slippage*100}%)`)
        
        const tx = await this.contract.quickMint.quickMint(
            this.contract.tasset.synthPool.address,
            collateralAmount,
            swapShareOutMin,
            offset,
            synthOutMin,
            option
        )
        const txReceipt = await tx.wait()

        const kusdAfterSwap = await this.contract.token.kusd.balanceOf(this.wallet.address) / 1e18;
        const tassetAfterSwap = await this.contract.tasset.token.balanceOf(this.wallet.address) / 1e18
        const kusdSpend = kusdBeforeSwap - kusdAfterSwap
        const tassetReceived = tassetAfterSwap - tassetBeforeSwap
        const gasSpent = ((this.gasPrice * 1e9) * (txReceipt.gasUsed)) / 1e18  // in BNB
        this.totalGasSpend += gasSpent

        console.log(`Minted [${tassetReceived.toFixed(4)} ${this.tasset}] with [${kusdSpend.toFixed(4)} KUSD]`)
        console.log(`Gas Fee used: ${gasSpent.toFixed(6)} BNB (${(gasSpent * this.bnbPrice).toFixed(2)} USD)`)
    }
            
    async redeemTAsset() {
        const synthBalance = await this.contract.tasset.token.balanceOf(this.wallet.address)  // tasset balance
        const synthAmount = synthBalance * 0.9999 / 1e18;

        const ecr = await this.contract.syntheticController.getECR() / 1e18;
        const sharePrice = await this.contract.syntheticController.getSharePrice() / 1e18
        const synthPrice = await this.contract.tasset.synthPool.getSynthPrice() / 1e18
        const collateralPrice = await this.contract.tasset.synthPool.getCollateralPrice() / 1e18
        
        const synthAmountPostFees = synthAmount * (1. - this.twindexRedeemFee)  // redeemable unit
        const synthDollarValue = synthAmountPostFees * synthPrice

        const shareReceived = synthDollarValue * (1. - ecr) / sharePrice
        const colalteralReceived = synthDollarValue * ecr / collateralPrice

        const shareOutMin = shareReceived * (1. - this.slippage)
        const minCollateralAmount = colalteralReceived * (1. - this.slippage)

        const _synthAmount = ethers.utils.parseEther(synthAmount.toString())
        const _shareOutMin = ethers.utils.parseEther(shareOutMin.toString())
        const _minCollateralAmonut = ethers.utils.parseEther(minCollateralAmount.toString())
        const gasLimit = await this.contract.tasset.synthPool.estimateGas.redeemFractionalSynth(
            _synthAmount,
            _shareOutMin,
            _minCollateralAmonut
        )

        const option = {
            gasPrice: ethers.utils.parseUnits(this.gasPrice.toString(), "gwei"),
            gasLimit: gasLimit.toString(),
        }

        const kusdBeforeSwap = await this.contract.token.kusd.balanceOf(this.wallet.address) / 1e18;
        const twxBeforeSwap = await this.contract.token.twx.balanceOf(this.wallet.address) / 1e18;
        const tassetBeforeSwap = await this.contract.tasset.token.balanceOf(this.wallet.address) / 1e18
        
        console.log(`>>>>>>>>>>REDEEMING ${this.tasset} to KUSD + TWX`)
        console.log(`> Redeeming [${synthAmount.toFixed(4)} ${this.tasset}] for ` 
            + `[${shareReceived.toFixed(4)} TWX] + ` 
            + `[${minCollateralAmount.toFixed(4)} KUSD] (Slippage ${this.slippage*100}%)`)

        const tx = await this.contract.tasset.synthPool.redeemFractionalSynth(
            _synthAmount,
            _shareOutMin,
            _minCollateralAmonut,
            option
        )
        const txReceipt = await tx.wait()

        const kusdAfterSwap = await this.contract.token.kusd.balanceOf(this.wallet.address) / 1e18;
        const twxAfterSwap = await this.contract.token.twx.balanceOf(this.wallet.address) / 1e18;
        const tassetAfterSwap = await this.contract.tasset.token.balanceOf(this.wallet.address) / 1e18;

        const tassetSpent = tassetBeforeSwap - tassetAfterSwap
        const kusdReceived = kusdAfterSwap - kusdBeforeSwap
        const twxReceived = twxAfterSwap - twxBeforeSwap
        const gasSpent = ((this.gasPrice * 1e9) * (txReceipt.gasUsed)) / 1e18  // in BNB
        this.totalGasSpend += gasSpent
        
        console.log(`Redeemed [${tassetSpent.toFixed(4)} ${this.tasset}] for `
            + `[${twxReceived.toFixed(4)} TWX] + `
            + `[${kusdReceived.toFixed(4)} KUSD]`
        )
        console.log(`Gas Fee used: ${gasSpent.toFixed(6)} BNB (${(gasSpent * this.bnbPrice).toFixed(2)} USD)`)
    }

    async swapTwxToKUSD() {
        const deadline = + new Date() + this.deadline * 60

        const amountIn = ((await this.contract.token.twx.balanceOf(this.wallet.address)) * 0.9999);  // tasset balance
        // calculate amountOutMin
        const amountInWithFee = amountIn * (1. - this.twindexSwapFee)  // defuct twindex fee 0.3%
        // compute amountOut
        const reserve = await this.getTwxReserves()
        const numerator = amountInWithFee * reserve.kusd
        const denominator = + reserve.twx + amountInWithFee
        const amountOut = numerator / denominator
        const _amountOutMin = ethers.utils.parseEther((amountOut * (1. - this.slippage) / 1e18).toString()); // in wei
        // routing path and wallet address
        const path = [this.contract.token.twx.address, this.contract.token.kusd.address]
        const to = this.wallet.address

        const _amountIn = ethers.utils.parseEther((amountIn / 1e18).toString())
        const gasLimit = await this.contract.twindexRouter.estimateGas.swapExactTokensForTokens(
            _amountIn,
            _amountOutMin,
            path,
            to,
            deadline
        )

        const option = {
            gasPrice: ethers.utils.parseUnits(this.gasPrice.toString(), "gwei"),
            gasLimit: gasLimit.toString(),
        }

        const kusdBeforeSwap = await this.contract.token.kusd.balanceOf(this.wallet.address) / 1e18;
        const twxBeforeSwap = await this.contract.token.twx.balanceOf(this.wallet.address) / 1e18
        
        console.log(">>>>>>>>>>SWAPPING TWX to KUSD")
        console.log(`> Swapping [${(amountIn / 1e18).toFixed(4)} TWX] for [${(amountOut / 1e18).toFixed(4)} KUSD] (Slippage ${this.slippage*100}%)`)

        const tx = await this.contract.twindexRouter.swapExactTokensForTokens(
            _amountIn,
            _amountOutMin,
            path,
            to,
            deadline,
            option
        )
        const txReceipt = await tx.wait();

        const kusdAfterSwap = await this.contract.token.kusd.balanceOf(this.wallet.address) / 1e18;
        const twxAfterSwap = await this.contract.token.twx.balanceOf(this.wallet.address) / 1e18;

        const kusdReceived = kusdAfterSwap - kusdBeforeSwap
        const twxSpent = twxBeforeSwap - twxAfterSwap
        const gasSpent = ((this.gasPrice * 1e9) * (txReceipt.gasUsed)) / 1e18  // in BNB
        this.totalGasSpend += gasSpent

        console.log(`Swapped [${kusdReceived} KUSD] for [${twxSpent.toFixed(4)} TWX]`)
        console.log(`Gas Fee used: ${gasSpent.toFixed(6)} BNB (${(gasSpent * this.bnbPrice).toFixed(2)} USD)`)
    }

    async computePositionSize(desiredPrice, assetIn, reserve) {
        // assetIn \in {kusd, tasset}
        // = kusd => buy tasset, else sell tasset
        const assetOut = assetIn == 'kusd' ? 'tasset' : 'kusd'
        const reserveIn = +reserve[assetIn] / 1e18
        const reserveOut = +reserve[assetOut] / 1e18

        let solution;
        if (assetIn === 'kusd') {
            const sqrt_term = (2 * reserveIn) ** 2 + (4 * (desiredPrice * reserveIn * reserveOut - (reserveIn ** 2)))
            solution = [
                (-(2 * reserveIn) + (sqrt_term) ** 0.5) / 2, 
                (-(2 * reserveIn) - (sqrt_term) ** 0.5) / 2, 
            ]
        } else {
            const sqrt_term = ((2 * desiredPrice * reserveIn) ** 2) - (4 * desiredPrice * ((desiredPrice * reserveIn ** 2) - (reserveIn * reserveOut)))
            solution = [
                ((-2 * desiredPrice * reserveIn) + (sqrt_term ** 0.5)) / (2 * desiredPrice), 
                ((-2 * desiredPrice * reserveIn) - (sqrt_term ** 0.5)) / (2 * desiredPrice), 
            ]
        }
        return solution[0] > 0 ? solution[0] : solution[1]
    }

    async displayAbtResult() {
        console.log("============= SUMMARY =============")
        const balanceAfterAbt = await this.contract.token.kusd.balanceOf(this.wallet.address) / 1e18
        const diff = balanceAfterAbt - this.balanceBeforeArbitrage
        const gasUsd = this.totalGasSpend * this.bnbPrice
        console.log(`Balance Before Arbitrage: ${this.balanceBeforeArbitrage.toFixed(4)} KUSD`)
        console.log(`Balance After Arbitrage: ${balanceAfterAbt.toFixed(4)} KUSD`)
        console.log(`Total money received: ${diff.toFixed(4)} KUSD`)
        console.log(`Total Gas Used: ${this.totalGasSpend.toFixed(6)} ($${gasUsd.toFixed(4)})`)
        console.log("==================================")

    }

    async executeArbitrage() {
        
        // get tasset oracle price
        const oraclePrice = await this.getOraclePrice()
        // get tasset swap price
        const swapPrice = await this.getTAssetSwapPrice(this.tasset)
        // get pct diff
        const pctDiff = (swapPrice - oraclePrice) / oraclePrice
        // calculate prices
        const reserve = await this.getReserves()
        this.bnbPrice = (await this.getPancakePrice(addresses.wbnb)).data.price;
        const twxReserves = (await this.getTwxReserves());
        this.twxPrice = twxReserves.kusd / twxReserves.twx;
        this.balanceBeforeArbitrage = await this.contract.token.kusd.balanceOf(this.wallet.address) / 1e18  // in KUSD

        console.log(`Current Balance: $${this.balanceBeforeArbitrage}`)
        console.log(`BNB Price (Pancake swap): $${this.bnbPrice}`)
        console.log(`TWX Price (Twindex): $${this.twxPrice}`)
        
        console.log(`Oracle Price: ${oraclePrice}; Swap Price: ${swapPrice} (${(pctDiff*100).toFixed(2)}%)`)
        // console.log(`Position sizing with ${positionSize.toFixed(4)} KUSD`)
        // if pct idff > threshold
        if (Math.abs(pctDiff) >= this.threshold) {
            if (oraclePrice > swapPrice) {
                // if oracle > swap (discount) -> buy tasset and redeem twx+kusd -> sell twx -> get kusd
                // swap KUSD
                console.log(`tAsset ${this.tasset} is currently discount!`)
                const desiredPrice = oraclePrice // * 0.993  // 0.7% redeem fee
                const positionSize = Math.min(await this.computePositionSize(desiredPrice, 'kusd', reserve), this.balanceBeforeArbitrage * 0.99)
                console.log(`Position size for arbitraging: ${positionSize.toFixed(4)} KUSD`)
                await this.swapKUSDToTAsset(positionSize, reserve)
                await this.redeemTAsset()  // redeem tasset
                await this.swapTwxToKUSD()
            } else {
                // else oracle < swap (premium) -> buy twx for collateral -> mint and sell -> get kusd
                console.log(`tAsset ${this.tasset} is currently premium!`)
                const desiredPrice = oraclePrice // * 0.997  // 0.3% mint fee
                let positionSize = await this.computePositionSize(desiredPrice, 'tasset', reserve)
                positionSize = Math.min(positionSize * oraclePrice, this.balanceBeforeArbitrage * 0.99)
                console.log(`Position size for arbitraging: ${positionSize.toFixed(4)} KUSD`)
                await this.mintTAsset(positionSize);
                await this.swapTAssetToKUSD(reserve);
            }
            this.displayAbtResult();
        } else {
            console.log(`TAsset ${this.tasset} is neither discount nor premium.`)
        }
    }

    async computePnL() {
        // get tasset oracle price
        const oraclePrice = await this.getOraclePrice()
        // get tasset swap price
        const swapPrice = await this.getTAssetSwapPrice(this.tasset)
        // get pct diff
        const pctDiff = (swapPrice - oraclePrice) / oraclePrice
        // calculate prices
        const reserve = await this.getReserves()
        this.bnbPrice = (await this.getPancakePrice(addresses.wbnb)).data.price;
        const twxReserves = (await this.getTwxReserves());
        this.twxPrice = twxReserves.kusd / twxReserves.twx;
        this.balanceBeforeArbitrage = await this.contract.token.kusd.balanceOf(this.wallet.address) / 1e18  // in KUSD

        console.log(`Current Balance: $${this.balanceBeforeArbitrage}`)
        console.log(`BNB Price (Pancake swap): $${this.bnbPrice}`)
        console.log(`TWX Price (Twindex): $${this.twxPrice}`)
        
        console.log(`Oracle Price: ${oraclePrice}; Swap Price: ${swapPrice} (${(pctDiff*100).toFixed(2)}%)`)
        // console.log(`Position sizing with ${positionSize.toFixed(4)} KUSD`)
        // if pct idff > threshold
        if (Math.abs(pctDiff) >= this.threshold) {
            if (oraclePrice > swapPrice) {
                const desiredPrice = oraclePrice // * 0.993  // 0.7% redeem fee
                
                const positionSize = await this.computePositionSize(desiredPrice, 'kusd', reserve)
                // const positionSize = Math.min(await this.computePositionSize(desiredPrice, 'kusd', reserve), this.balanceBeforeArbitrage * 0.99)
                
                console.log(`Position size for arbitraging: ${positionSize.toFixed(4)} KUSD`)
                await this.computeDiscountPnL(positionSize)
            } else {
                const desiredPrice = oraclePrice // * 0.997  // 0.3% mint fee
                let positionSize = await this.computePositionSize(desiredPrice, 'tasset', reserve)

                positionSize = positionSize * oraclePrice
                // positionSize = Math.min(positionSize * oraclePrice, this.balanceBeforeArbitrage * 0.99)

                console.log(`Position size for arbitraging: ${positionSize.toFixed(4)} KUSD`)
                await this.computePremiumPnL(positionSize)
            }
        } else {
            console.log(`TAsset ${this.tasset} is neither discount nor premium.`)
        }
    }
}