export const CLI_HELP = `Trebuchet CLI (experimental; demo execution)

Usage:
  trebuchet doctor [--json]
  trebuchet plan build --config <launch.json> [--out <plan.json>] [--json]
  trebuchet plan verify <plan.json> [--json]
  trebuchet estimate (--plan <plan.json> | --config <launch.json>) [--json]
  trebuchet proof verify <proof.json> [--json]
  trebuchet execute --config <launch.json> [--network demo] [--out <run.json>]
                   [--server <server.js>] [--timeout <seconds>] [--json]

Global options:
  --json       Emit one versioned result envelope to stdout.
  --help       Show this help.
  --version    Show CLI and Core versions.

'trebuchet execute' runs a complete launch on the built-in demo chain:
no real RPC, no funds, disposable wallet. Live execution (mainnet/devnet)
remains blocked until custody, journal, idempotency, and non-interactive
confirmation contracts move into Core and pass a funded devnet recovery
cycle.`;