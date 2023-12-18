// @ts-check
const fs = require('fs')
const path = require('path')
const { knex } = require('knex')
const config = require('config')
const { cwd } = require('process')

const STATS_FILE = path.resolve(__dirname, '../.cache/stats.json')
const ACCOUNTS_FILE = path.resolve(__dirname, '../.cache/accounts.csv')
const KINAN_OUTPUT_FOLDER = path.resolve(cwd(), config.get('kinanOutputFolder'))
const LAST_COUNT_FILE = path.resolve(__dirname, '../.cache/lastCount.txt')

/**
 * Wrapped around `fetch` with an abort controller and error catcher
 * @param {string} url
 * @param {RequestInit & { waitTime?: number }} [options]
 */
const fetchWrapper = async (
  url,
  { waitTime, ...options } = { waitTime: 5000 }
) => {
  const signal = new AbortController()
  const timeout = setTimeout(() => signal.abort(), waitTime)
  try {
    const res = await fetch(url, {
      ...options,
      signal: signal.signal,
    })
    return res
  } catch (e) {
    console.error(e)
    return { status: 500 }
  } finally {
    clearTimeout(timeout)
  }
}

if (!fs.existsSync(LAST_COUNT_FILE)) {
  fs.writeFileSync(LAST_COUNT_FILE, '0')
}

async function main() {
  const { reloadUrl: levelerReload, ...levelerDb } = config.get('levelerDb')

  const leveler = knex({
    client: 'mysql2',
    connection: levelerDb,
  })

  const reloadUrls = levelerReload ? [levelerReload] : []

  /**
   * @type {{ connection: typeof leveler, ratio: number, name: string }[]}
   */
  const destinationDbs = config
    .get('destinationDbs')
    .map(({ reloadUrl, ratio, ...db }) => {
      if (reloadUrl) reloadUrls.push(reloadUrl)
      return {
        connection: knex({ client: 'mysql2', connection: db }),
        ratio,
        name: db.database,
      }
    })

  const stats = {
    newAccounts: 0,
    newThirties: 0,
    timestamp: Date.now(),
  }

  if (config.get('kinanOutputFolder')) {
    const allAccounts = fs.readdirSync(KINAN_OUTPUT_FOLDER).flatMap((file) => {
      const lines = fs
        .readFileSync(path.resolve(KINAN_OUTPUT_FOLDER, file), 'utf-8')
        .split('\n')
        .filter((l) => !l.startsWith('#') && l.endsWith('OK;'))
      return lines.map((line) => {
        const [user, pass, email] = line.split(';')
        return `${user},${pass},${email}`
      })
    })

    const existingAccounts = new Set(
      (fs.existsSync(ACCOUNTS_FILE)
        ? fs.readFileSync(ACCOUNTS_FILE, 'utf-8').split('\n')
        : []
      ).map((row) => {
        const [username] = row.split(',')
        return username.trim()
      })
    )

    fs.writeFileSync(
      path.resolve(ACCOUNTS_FILE),
      allAccounts.join('\n'),
      'utf8'
    )

    const newAccounts = allAccounts.filter((account) => {
      const [username] = account.split(',')
      return !existingAccounts.has(username)
    })
    stats.newAccounts = newAccounts.length

    const accountsForDb = newAccounts.map((account) => {
      const [username, password] = account.split(',')
      return { username, password, level: 0 }
    })

    if (accountsForDb.length) {
      await leveler('account')
        .insert(accountsForDb)
        .onConflict('username')
        .ignore()
    }
  } else {
    const lastCount = parseInt(fs.readFileSync(LAST_COUNT_FILE, 'utf-8'))
    const newAccounts = await leveler('account')
      .count('username', { as: 'total' })
      .first()
    const diff = (+(newAccounts?.total || 0) || 0) - lastCount
    stats.newAccounts = diff
    fs.writeFileSync(LAST_COUNT_FILE, `${newAccounts?.total || lastCount}`)
  }
  console.log('Made', stats.newAccounts, 'new accounts')

  const newThirties = await leveler('account')
    .where('banned', '=', 0)
    .where('level', '>', 29)
  stats.newThirties = newThirties.length
  console.log(newThirties.length, 'ready for use!')

  if (newThirties.length) {
    await leveler('account')
      .update({ banned: true })
      .whereIn(
        'username',
        newThirties.map((account) => account.username)
      )

    for (const { connection, ratio, name } of destinationDbs) {
      const isLast = destinationDbs[destinationDbs.length - 1]?.name === name
      const accounts = isLast
        ? newThirties
        : newThirties.splice(0, Math.floor(newThirties.length * ratio))

      if (accounts.length) {
        stats[`new${name}`] = accounts.length
        await connection('account')
          .insert(accounts)
          .onConflict('username')
          .ignore()
        console.log('Inserted', accounts.length, 'into', name)
      }
    }
  }

  /** @type {(typeof stats)[]} */
  const existingStats = fs.existsSync(STATS_FILE)
    ? JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8'))
    : []

  existingStats.push(stats)

  fs.writeFileSync(STATS_FILE, JSON.stringify(existingStats))

  /** @type {Record<string, number>} */
  const goodThirties = Object.fromEntries(
    await Promise.all(
      destinationDbs.map(async ({ connection, name }) => {
        const goodThirties = await connection('account')
          .where('level', '>', 29)
          // .andWhere('banned', 0)
          // .andWhere('invalid', 0)
          // .whereNull('last_disabled')
          .count('username', { as: 'total' })
          .first()
        return [name, goodThirties?.total ?? 0]
      })
    )
  )

  if (config.get('discordWebhookurl')) {
    await fetchWrapper(config.get('discordWebhookurl'), {
      waitTime: 5000,
      method: 'POST',
      headers: {
        'Content-type': 'application/json',
      },
      body: JSON.stringify({
        content: null,
        embeds: [
          {
            title: 'Leveling Stats',
            color: 5814783,
            fields: [
              {
                name: 'Number of Level 0s Created',
                value: `${stats.newAccounts.toLocaleString()}`,
              },
              {
                name: 'Number of Level 30s Created',
                value: `${stats.newThirties.toLocaleString()}`,
              },
              ...destinationDbs.map(({ name }) => ({
                name: `Number of Level 30s Added to ${name}`,
                value: `${stats[`new${name}`] || 0}`,
              })),
            ],
            timestamp: new Date().toISOString(),
          },
          {
            title: 'Fresh Accounts',
            color: 5814783,
            fields: Object.entries(goodThirties).map(([name, total]) => ({
              name: `Number of Level 30s in ${name}`,
              value: `${total.toLocaleString()}`,
            })),
            timestamp: new Date().toISOString(),
          },
        ],
        attachments: [],
      }),
    }).then((res) => console.log('Webhook status', res?.status))
  }

  await Promise.all(
    destinationDbs.map(async (db) => await db.connection.destroy())
  )
  await leveler.destroy()

  const date = new Date()
  if (date.getHours() === 4 && date.getMinutes() < 10) {
    // only reload once at midnight
    await Promise.allSettled(
      reloadUrls.map((url) =>
        fetchWrapper(url)
          .then((res) => console.log(url, res?.status))
          .catch((err) => console.error(url, err))
      )
    )
  }
}

main().then(() => console.log('OK!'))
