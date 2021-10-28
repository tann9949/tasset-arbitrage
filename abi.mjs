import { tasset_synth } from './contract-abi/tassets_synth.mjs'
import { tassetRouter } from './contract-abi/tassets_router.mjs'
import { quickMint } from './contract-abi/quickmint.mjs'
// token
import { kusd } from './contract-abi/kusd.mjs'
// tassets
import { tAsset } from './contract-abi/tasset.mjs'
// LPs
import { twx_kusd } from './contract-abi/twx-kusd.mjs'
import { kusd_tAssets } from './contract-abi/kusd-tAssets.mjs'
// factory
import { synthPool } from './contract-abi/synthPool.mjs'
// link oracle
import { tAssetOracle } from './contract-abi/tassetOracle.mjs'
import { kusdOracle } from './contract-abi/kusd-oracle.mjs'


export const ABI = {
    oracle: {
        kusd: kusdOracle
    },
    token: {
        kusd
    },
    twindex: {
        swap: twx_kusd,
        router: tassetRouter,
        quickMint: quickMint
    },
    tasset: {
        controller: tasset_synth,
        synthPool: synthPool,
        lp: kusd_tAssets,
        token: tAsset,
        oracle: tAssetOracle
    }
}