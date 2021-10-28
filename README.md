# TAsset Arbitrageur
My personal bot for arbitraging tAssets on [Twindex](https://twindex.com). **Use at your own risk**

## Installation
To install project dependencies **make sure your computer have node.js installed**. Then, run the following command:
```bash
npm install
```

## Usage
### Configurations
To run the bot, `.env` file is required to read your wallet's mneumonic phrase (make sure you use your newly created wallet). You can see an example on `.env.example`. There are two fields, one is optional and one is required.

```bash
SEED="your seed phrase"  # for running arbitrage
LINE_TOKEN="line-notify-token"  # for notify if new tasset is created
```

### Using scripts
There are three main scripts on this project
#### 1. `newTassetListener`
This script will run indefinitely so make sure you run on either `docker` or `tmux` (or your remote server). This script requires `LINE_TOKEN` in `.env` file to notify user that new tAsset is being created. To run the script, use the following command
```bash
npm run listen
```
#### 2. `checkPnL.mjs`
This script receives two arguments
1. tasset name (Prompts are case sensitive. For example, tTSLA != ttsla)
2. discount/premium threshold
The script will calculate the net PnL of arbitraging the prompted tAsset. The script can be run as followed:
```bash
npm run test -- <tasset-name> <discount/premium-thresh>
# example
npm run text -- tTSLA 0.03
# this means that the script will calculate arbitraging PnL
# of tTSLA given that discount/premium must be > 3%
```

#### 3. `arbitrageListener.mjs`
**USE AT YOUR OWN RISK. THE CREATOR WON'T RESPONSIBLE FOR ANY LOSS THAT OCCURED IF SCRIPT IS BUGGED. IT IS A RESPONSIBILITY OF USERS TO ACKNOWLEDGE THE RISK OF SCRIPT BUGGED**. 

This is the main script that will be used for arbitraging. It will first run arbitrage then listening for swapping/price updating event and check if discount/premium passed the prompted threshold. **THIS SCRIPT DOES NOT CHECK IF POSITION IS PROFITABLE OR NOT.** However, it can be used together with method from `checkPnL.mjs` but i'm too busy to update. Feel free to do any pull request.

To run the script:
```bash
npm run start -- <tasset-name> <discount/premium-thresh>
# example
npm run text -- tTSLA 0.03
# this means that the script will arbitrage tTSLA
# given that discount/premium must be > 3%
# Then the script will continue to listen
```

The script is running indefinitely. Thus, use your own method to make sure session is not close.

## Author
Chompakorn Chaksangchaichot