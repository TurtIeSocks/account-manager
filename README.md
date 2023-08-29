# Kinan Account Manager

## Description

Basic JS script to move accounts around depending on status and report stats to a Discord webhook.

## Requirements

1. NodeJS 18+
2. MySQL

## Setup

1. Clone the repo
2. Install dependencies with `npm install`
3. Fill out config `cp config/default.json config/local.json`
4. Run with `npm start`
5. (Optional) Run on a cron schedule with PM2 `pm2 start ./src/index.js --name accounts --cron "*/30 * * * *"`

## Config

### `discordWebhookUrl`

A Discord webhook address to send reports to.

### `kinanOutputFolder`

The _relative_ path from the directory that you're executing this script. So if you're in the root of this project, and your output is in `../kinan/output`, you would put that here.

### `levelerDb`

The database for your dedicated leveler instance. If you aren't using a dedicated leveler, you probably don't need this script. The `reloadUrl` key is if you want to call an API to refresh the accounts in memory, or something.

### `destinationDbs`

You can put any number of databases here that you wish to distribute accounts to. You must set the `ratio` for every database. So if you want to split them evenly between two destinations you would put `0.5` for each. If you want to send 1/3 of the accounts to one destination and 2/3 to another, you would put `0.333` and `0.666` respectively.
