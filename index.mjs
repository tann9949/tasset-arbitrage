import { ArbitrageListener } from './arbitrageListener.mjs'
import { addresses } from './address.mjs'

async function main() {
    const tasset = process.argv[2]
    const threshold = process.argv[3]
    let slippage = process.argv[4]

    if (Object.keys(addresses.tassets).indexOf(tasset) === -1) {
        console.error(`Unrecognized tAsset: ${tasset}`)
        process.exit(1)
    }

    if (!threshold || threshold < 0 || threshold > 1) {
        console.error(`threshold must be within range (0, 1)`)
        process.exit(1)
    }

    if (!slippage) {
        // if not parsed, default at 1%
        slippage = 0.01
    }

    const listener = new ArbitrageListener(
        tasset,
        threshold,  // threshold
        slippage, // slippage
    )
    listener.arbitrageur.executeArbitrage().then(() => {
        listener.listenForArbitrage()
    }).catch((e) => {
        console.error(e)
        process.exit(1);
    })
}

main()