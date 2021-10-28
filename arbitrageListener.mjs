import { ethers } from "ethers"
import { TAssetArbitrageur } from "./tassetArbitrageur.mjs";
import { addresses } from './address.mjs'

export class ArbitrageListener {

    constructor(tasset, threshold, slippage, estimateGasOnly) {
        this.rpcURL = "https://bsc-dataseed.binance.org/";
        // this.rpcURL = "https://bsc-dataseed1.defibit.io/"
        this.provider = new ethers.providers.JsonRpcProvider(this.rpcURL);
        this.tasset = tasset
        
        this.arbitrageur = new TAssetArbitrageur(
            this.provider,  // provider
            tasset,  // tasset
            threshold,
            slippage, 
            estimateGasOnly    // estimateGasOnly
        )
    }

    listenForArbitrage() {
        // listen on block
        console.log("Initializing oracle price adjust listener...")
    
        // on new oracle price feed
        const oracleFilter = {
            address: addresses.tassets[this.tasset].oracle,
            topics: [
                '0xf6a97944f31ea060dfde0566e4167c1a1082551e64b60ecb14d599a9d023d451'
            ]
        }
        this.provider.on(oracleFilter, async (log, event) => {
            const txnHash = log.transactionHash
            console.log("***************************")
            console.log(`Oracle price ${this.tasset} updated!`)
            console.log(`Transaction hash: ${txnHash}`)
            console.log("***************************")
            this.arbitrageur.executeArbitrage()
        })
        
        // on people swap
        const swapFilter = {
            address: this.arbitrageur.contract.tasset.swap.address,
            topics: [
                '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822',
            ]
        }
        console.log(`Initializing KUSD-${this.tasset} swap listener...`)
        this.provider.on(swapFilter, async(log, event) => {
            const txnHash = log.transactionHash
            console.log("***************************")
            console.log("Someone swapped on Twindex!")
            console.log(`Transaction hash: ${txnHash}`)
            console.log("***************************")
            this.arbitrageur.executeArbitrage()
        })
    }
}