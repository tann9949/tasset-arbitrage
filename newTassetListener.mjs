import { ethers } from 'ethers'
import { config } from 'dotenv'
import fetch from 'node-fetch'

import { addresses } from './address.mjs'

config()

class TAssetListener {

    constructor() {
        this.rpcURL = "https://bsc-dataseed.binance.org/";
        // this.rpcURL = "https://bsc-dataseed1.defibit.io/"
        this.provider = new ethers.providers.JsonRpcProvider(this.rpcURL);
    }

    async notifyLINE(message) {
        const headers = {
            'content-type': 'application/x-www-form-urlencoded',
            'Authorization': 'Bearer ' + process.env.LINE_TOKEN
        }

        try {
            var res = await fetch('https://notify-api.line.me/api/notify', {
                method: 'POST',
                body: qs.stringify({ message: '\n' + message }),
                headers: headers
            })
            res = await res.json()
            console.log(res)
        } catch (e) {
            console.log(e)
        }
    }

    async run() {
        // listen on block
        console.log("Listening for tAssets listener...")

        const newAssetFilter = {
            address: addresses.twindex.synthController,
            topics: [
                '0x01aa82cfa990398c4ccf47aa760974ee7396ce3d02ad3e6d10efa89833273667'  // new synth
            ]
        }
        this.provider.on(newAssetFilter, async(log, event) => {
            const txnHash = log.transactionHash
            console.log("New tAsset created on Twindex!")
            console.log(`Transaction hash: ${txnHash}`)
            this.notifyLINE(`New tAsset minted!\nCheck out at https://bscscan.com/tx/${txnHash}`)
        })
    }
}

async function main() {
    const listener = new TAssetListener()
    listener.run()
}

main();