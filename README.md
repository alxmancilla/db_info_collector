# MongoDB Atlas Cluster Sizing - Data Collection Guide

## Overview

This guide will help you collect the necessary data from your MongoDB deployment to perform an accurate cluster sizing exercise. The sizing analysis will determine the optimal Atlas cluster tier for your workload.

## Quick Start (≈ 5 minutes)

If this is your first time, follow these three steps. Skip ahead to [Prerequisites](#prerequisites) only if you need platform-specific install instructions or want to limit privileges.

**1. Install `mongosh`** (skip if `mongosh --version` already works):

```bash
# macOS
brew install mongosh
# Windows
winget install MongoDB.Shell
# Linux / other: see "Installing mongosh" below
```

**2. Get your connection string:**

- **MongoDB Atlas:** Atlas UI → **Database** → click **Connect** on your cluster → **Drivers** → copy the `mongodb+srv://...` URI. Replace `<db_password>` in the URI with your actual password. If you don't have a database user yet, click **Add new database user** in the same dialog and grant `Atlas admin` (or follow [`scripts/create_sizing_user.js`](scripts/create_sizing_user.js) for a minimum-privilege user).
- **Self-hosted:** `mongodb://<host>:27017` for a single node, or `mongodb://host1,host2,host3/?replicaSet=<name>` for a replica set.
- **Atlas IP access list:** make sure the machine you're running from is allowed (Atlas UI → **Network Access**).

**3. Run the script during normal or even peak hours** (from the repository root):

```bash
mongosh "<your-connection-string>" --file scripts/collect_sizing_data.js > sizing_data_output.txt
```

What to expect:

- The script runs for about **60–75 seconds** (60 s is the operations sample window).
- The terminal prints a live summary while the JSON report is written to `sizing_data_output.txt`.
- A successful run ends with `Skipped Collections: N` followed by `FULL REPORT (save this output):` and the JSON dump.

When it finishes, send `sizing_data_output.txt` to your MongoDB contact. That's it — everything below is optional detail.

## Prerequisites

- MongoDB 4.4+ deployment (including MongoDB 7.x and MongoDB 8.0)
- `mongosh` (MongoDB Shell) installed and access to your cluster
- Sufficient privileges to run `serverStatus`, `dbStats`, and collection statistics commands
- Recommended: read-only user with `clusterMonitor` role (minimum) — see [`scripts/create_sizing_user.js`](scripts/create_sizing_user.js)

### Installing `mongosh`

Check whether `mongosh` is already installed:

```bash
mongosh --version
```

If the command is not found, install the latest version using the method appropriate for your platform.

**macOS (Homebrew):**

```bash
brew install mongosh
```

**Linux (Ubuntu/Debian):**

```bash
wget -qO - https://www.mongodb.org/static/pgp/server-7.0.asc | sudo gpg --dearmor -o /usr/share/keyrings/mongodb-server-7.0.gpg
echo "deb [arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg] https://repo.mongodb.org/apt/ubuntu $(lsb_release -cs)/mongodb-org/7.0 multiverse" | sudo tee /etc/apt/sources.list.d/mongodb-org-7.0.list
sudo apt-get update
sudo apt-get install -y mongodb-mongosh
```

**Linux (RHEL/CentOS/Amazon Linux):**

```bash
sudo tee /etc/yum.repos.d/mongodb-org-7.0.repo <<'EOF'
[mongodb-org-7.0]
name=MongoDB Repository
baseurl=https://repo.mongodb.org/yum/redhat/$releasever/mongodb-org/7.0/x86_64/
gpgcheck=1
enabled=1
gpgkey=https://www.mongodb.org/static/pgp/server-7.0.asc
EOF
sudo yum install -y mongodb-mongosh
```

**Windows (winget):**

```powershell
winget install MongoDB.Shell
```

**Manual download (all platforms):**

If a package manager is unavailable or you need an offline install, download the standalone binary from the official MongoDB site: <https://www.mongodb.com/try/download/shell>. Pick the package matching your OS and architecture, extract it, and add the `bin/` directory to your `PATH`.

Verify the install:

```bash
mongosh --version
```

## Compatibility

✅ Fully compatible with MongoDB 4.4, 5.0, 6.0, 7.0, and 8.0.

The scripts in this guide use standard MongoDB commands (`stats()`, `serverStatus()`, `listDatabases`) that are stable across all these versions. MongoDB 8.0 maintains backward compatibility with these administrative commands.

## What Data We're Collecting

The sizing exercise requires the following information:

**Workload Metrics**
- Read operations per second (peak)
- Write operations per second (peak)
- Average document size
- Total data size (current and projected)
- WiredTiger cache pressure: hit ratio, pages read into cache, eviction rates (modified vs unmodified)

**Schema Information**
- Number of collections
- Number of secondary indexes per collection
- Document counts
- Time-series collections: bucket count and link to the underlying `system.buckets.*` storage

**Hardware Resources** (per node where possible)
- CPU cores (logical and physical), architecture, NUMA
- Total memory and cgroup limit
- WiredTiger cache: configured maximum and current usage
- Resident / virtual memory
- Current and available connections
- Network counters (bytes in/out, num requests)
- Process uptime
- **Note:** disk size, free space, and IOPS are not exposed by mongosh and must be recorded separately (Atlas Metrics API for Atlas; `df` / `lsblk` for self-hosted)

**Operational Requirements**
- Latency requirements (< 50ms or relaxed)
- High availability needs (single-region vs multi-region)
- Workload pattern (consistent vs intermittent)
- Bulk operations usage

**Replication & Per-Namespace Workload**
- Oplog size and window (hours of write history retained)
- Per-secondary replication lag
- Per-namespace read/write/command rates (which collections drive load)

## Repository Layout

| File | Purpose |
| --- | --- |
| [`scripts/collect_sizing_data.js`](scripts/collect_sizing_data.js) | **Recommended.** All-in-one collection script (Steps 2, 3, and optionally 5 in one pass) |
| [`scripts/03_workload_questionnaire.js`](scripts/03_workload_questionnaire.js) | Workload requirements questionnaire template (Step 4) |
| [`scripts/01_database_collection_stats.js`](scripts/01_database_collection_stats.js) | Granular database and collection statistics (alternative to Step 2 of the automated script) |
| [`scripts/02_ops_per_second.js`](scripts/02_ops_per_second.js) | Granular 60-second operations-per-second measurement (alternative to Step 3 of the automated script) |
| [`scripts/04_index_usage_all_nodes.js`](scripts/04_index_usage_all_nodes.js) | Standalone replica-set-wide `$indexStats` union (alternative to enabling the cluster-wide flag) |
| [`scripts/05_index_usage_sharded.js`](scripts/05_index_usage_sharded.js) | Standalone cluster-wide `$indexStats` union across all shards (alternative to enabling the cluster-wide flag) |
| [`scripts/verify_mongodb_version.js`](scripts/verify_mongodb_version.js) | Verify MongoDB version and storage engine |
| [`scripts/create_sizing_user.js`](scripts/create_sizing_user.js) | Create minimum-privilege user for data collection |

## Recommended: Automated Collection Script

The fastest path to a complete sizing dataset is [`scripts/collect_sizing_data.js`](scripts/collect_sizing_data.js). It performs the database/collection statistics pass, a 60-second `opcounters` sample, and (optionally) a cluster-wide `$indexStats` union in a single run, emitting one JSON report.

### Step 1: Get Your Connection String

You don't need to open an interactive shell — just have a connection string ready to pass to `--file` in Step 2.

**MongoDB Atlas:**

1. Atlas UI → **Database** → click **Connect** on your cluster.
2. Choose **Drivers** (not "MongoDB Shell").
3. Copy the URI — it looks like `mongodb+srv://<user>:<db_password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority`.
4. Replace `<db_password>` with the real password (URL-encode special characters if any).
5. Make sure your machine's IP is in **Network Access** (Atlas UI).

**Self-hosted MongoDB:**

```bash
# Single node
mongodb://<username>:<password>@<host>:27017/?authSource=admin

# Replica set
mongodb://<username>:<password>@host1:27017,host2:27017,host3:27017/?replicaSet=<setName>&authSource=admin
```

If you'd rather supply the password interactively, omit `:<password>` from the URI and pass `--username <user>` to `mongosh`; you'll be prompted.

### Step 2: Run the Automated Script

From the repository root, replace `<your-connection-string>` with the URI from Step 1:

```bash
mongosh "<your-connection-string>" --file scripts/collect_sizing_data.js > sizing_data_output.txt
```

Run this **during peak hours** so the 60-second `opcounters` sample reflects realistic load. For bursty workloads, run it across several peak periods and keep the highest values observed.

**Verify it worked.** A successful run takes ~60–75 seconds and the terminal prints something like:

```
============================================================
MongoDB Atlas Sizing - Data Collection Script
MongoDB Version: <X.Y.Z>
============================================================
✓ Cluster info collected …
✓ Data metrics collected …
Measuring operations (60 second sample)…
✓ Operations metrics collected …
✓ Replication info collected …
============================================================
COLLECTION COMPLETE - SUMMARY
============================================================
…summary tables…
Skipped Collections: <N> (see report.dataMetrics.skippedCollections[] for reasons)
============================================================
FULL REPORT (save this output):
============================================================
{ collectionTimestamp: …, mongoVersion: …, clusterInfo: { … }, … }
```

`sizing_data_output.txt` should be several thousand lines on a non-trivial cluster. Send that file (and the questionnaire output from Step 4) to your MongoDB contact.

If you see `MongoServerError: command … requires authentication` or `not authorized on … to execute command`, your user is missing privileges — see [Troubleshooting → Permission Errors](#permission-errors). If `mongosh` itself fails to connect, double-check the password substitution and the Atlas Network Access list.

The output includes:

- `clusterInfo` — MongoDB version, storage engine, and a `localSnapshot` for the connected node with:
    - `system` — CPU cores (logical and physical), CPU architecture, NUMA, total memory and cgroup limit
    - `os` and `extra` — OS type/name/version, kernel version, libc version, page size, max open files, CPU frequency
    - `memory` — resident and virtual memory of the mongod process
    - `wiredTigerCache` — configured maximum, bytes currently in cache, tracked dirty bytes
    - `connections` — current, available, total created
    - `network` — bytes in/out, num requests
    - `uptimeSeconds` — process uptime (used to interpret `lifetimeAverage` below)
    - `diskInfo.note` — explicit reminder that disk size/free/IOPS must be collected separately
- `clusterInfo.nodes[]` — populated only when the optional cluster-wide collection is enabled (see Step 3). Same shape as `localSnapshot`, one entry per data-bearing member, tagged with `nodeKey` and `role` (PRIMARY/SECONDARY).
- `dataMetrics` — total data size, document counts, average document size, compression ratio, per-collection index counts and sizes, unused-index counts, max secondary indexes on a single collection. For time-series collections, per-collection entries on `system.buckets.*` carry `isTimeseriesBucketStorage: true`, `parentTimeseriesNs`, and `docsMeaning: "bucket count (not measurement count)"` so the relationship to the logical TS namespace is explicit. `skippedCollections[]` enumerates views and TS logical namespaces (whose storage is reported via the bucket entry).
- `operationsMetrics`:
    - `lifetimeAverage` — instant snapshot (`opcounters / uptime`), plus `cacheHitRatioPct` since process start. Useful as a sanity floor; **diluted by idle hours and restarts — do not use for peak sizing.**
    - `windowedSample` — sampled over `OPS_SAMPLE_WINDOW_SECONDS` (default 60) with measured elapsed time. Includes a `cache` block with:
        - `hitRatioPct` — `100 * (1 - pagesReadIntoCache / pagesRequestedFromCache)`; close to 100% indicates the working set fits in the WT cache.
        - `pagesReadIntoCachePerSec` — non-zero values indicate cache misses (working set spilling).
        - `pagesWrittenFromCachePerSec` — sustained writes from cache; correlates with disk IOPS pressure.
        - `modifiedPagesEvictedPerSec` / `unmodifiedPagesEvictedPerSec` — high modified-eviction rates indicate cache pressure forcing dirty pages out.
        - `bytesCurrentlyInCacheEnd` / `trackedDirtyBytesEnd` — absolute WT cache occupancy at the end of the sample window.
        - `byNamespace[]` — per-namespace `{ ns, readOpsPerSec, writeOpsPerSec, commandOpsPerSec, totalOpsPerSec }` derived from `db.adminCommand({top: 1})` deltas across the same window. Values are fractional (2 decimals) so sub-1 ops/s namespaces are still visible; the array is sorted by raw delta count (preserves ordering at sub-1 ops/s granularity). User namespaces only — system namespaces are summarized separately below. `byNamespaceNote` is set when `top()` is unavailable (mongos connections).
        - `systemNamespaceTotals` — aggregated ops/sec on `admin.*`, `config.*`, `local.*` (oplog writes, session refresh, transaction table). Explains some of any gap between `opcounters` totals and the user-namespace sums in `byNamespace[]`.
        - `reconciliation` — explicit comparison between `opcounters` and `top()` sums: `opcountersWritesPerSec`, `topAccountedWritesPerSec`, `unaccountedWritesPerSec` (and the same for reads). A non-trivial `unaccountedWritesPerSec` is normal on workloads dominated by `bulkWrite` / `insertMany` / `findAndModify` / time-series inserts — `top()` reports those as `commands` on the target namespace rather than as `insert`/`update`/`remove`, so they appear in `byNamespace[].commandOpsPerSec` but not in the write totals. Atlas-internal maintenance writers (profiler, audit, change-stream acknowledgments) also contribute. Use this block to decide whether reported per-namespace writes are the full picture.
    - `atlasApiNote` — for Atlas clusters, the canonical peak comes from the Atlas Metrics API (`OPCOUNTER_*` at `PT1M` granularity over a 7-day window).
- `replicationInfo` — `topology` (`replicaSet` / `sharded` / `standalone`), and for replica sets:
    - `oplog` — `logSizeMB`, `usedMB`, `timeDiffHours` (oplog window), `tFirst` / `tLast`. A window below ~24h on a write-heavy workload suggests the oplog is undersized for safer recovery / initial sync.
    - `members[]` — per-member `{ name, state, health, optimeDate, lagSeconds }`. `lagSeconds` is `0` for the primary and the wall-clock delta against the primary's optime for each secondary. Sustained non-zero lag on a SECONDARY indicates the tier or network can't keep up with primary write rate.
    - On mongos, only a `note` is set — run the script against each shard's primary for per-shard replication detail.

### Step 3 (optional): Enable Cluster-Wide Index Usage

By default the script is non-interactive and `$indexStats` only reflects the node `mongosh` connected to. To union `$indexStats` across **every** mongod in the deployment, edit the constants at the top of the script:

```js
var COLLECT_CLUSTER_WIDE_INDEX_USAGE = true;
var DIRECT_CONNECT_USERNAME          = "sizingUser";
var DIRECT_CONNECT_AUTH_SOURCE       = "admin";
var DIRECT_CONNECT_TLS               = true; // Atlas requires TLS
```

When enabled, the script:

- Auto-detects topology via `isMaster` (sharded → walks every shard's members; replica set → walks every member; standalone → skipped).
- Prompts once for the password via `passwordPrompt()` (never written to argv or disk).
- Opens a direct connection to each data-bearing member, skipping arbiters.
- Merges the union into `report.indexUsageClusterWide`, including an `unusedEverywhere` list of indexes safe to consider for removal.

The user must have read access on every database on every node — see [`scripts/create_sizing_user.js`](scripts/create_sizing_user.js). On Atlas, every replica-set member hostname must be reachable from the machine running the script (verify your IP access list).

### Step 4: Complete the Workload Questionnaire

The automated script cannot infer business requirements (latency targets, HA needs, data growth projections). Before running the questionnaire script, **open it in an editor and fill in the `answers` block at the top with your actual values** — the defaults are placeholders.

```bash
# 1. Edit the answers (latency, regions, growth, etc.)
$EDITOR scripts/03_workload_questionnaire.js

# 2. Run to emit a structured record
mongosh "<your-connection-string>" --file scripts/03_workload_questionnaire.js > questionnaire_output.txt
```

Send `questionnaire_output.txt` alongside `sizing_data_output.txt`.

## Alternative: Granular Step-by-Step Scripts

If you prefer to run each collection step independently — for example, to limit the privileges of the collecting user, stagger runs across maintenance windows, or skip the 60-second ops sample — use the granular scripts below. The output shape is equivalent to the corresponding sections of `collect_sizing_data.js`.

### Database and Collection Statistics

```bash
mongosh "<your-connection-string>" --file scripts/01_database_collection_stats.js > step2_output.txt
```

### Operations Per Second (Peak Load)

Run [`scripts/02_ops_per_second.js`](scripts/02_ops_per_second.js) during peak hours; it samples `opcounters` over 60 seconds.

```bash
mongosh "<your-connection-string>" --file scripts/02_ops_per_second.js > step3_output.txt
```

- Run multiple times during different peak periods.
- Record the highest values observed.
- Capture both peak and average if your workload is intermittent.

### Cluster-Wide Index Usage

Equivalent to enabling `COLLECT_CLUSTER_WIDE_INDEX_USAGE` in the automated script. Pick the script that matches your topology.

**Replica set** — [`scripts/04_index_usage_all_nodes.js`](scripts/04_index_usage_all_nodes.js):

```bash
mongosh "<your-connection-string>" --file scripts/04_index_usage_all_nodes.js > step5_output.txt
```

**Sharded cluster** — [`scripts/05_index_usage_sharded.js`](scripts/05_index_usage_sharded.js) connected to a `mongos`:

```bash
mongosh "mongodb+srv://<mongos-url>" --file scripts/05_index_usage_sharded.js > step5_output.txt
```

Both scripts read the topology, open direct connections to every data-bearing member, union the results, and list indexes safe to consider for removal. Edit the `USERNAME`, `AUTH_SOURCE`, and `TLS` constants at the top before running; you will be prompted for the password.

## MongoDB 8.0 Specific Notes

### New Features in MongoDB 8.0

While the sizing scripts remain compatible, MongoDB 8.0 introduces several features that may affect your sizing considerations:

- **Queryable Encryption Enhancements** — may impact document size and index counts.
- **Time Series Collection Improvements** — better compression for time-series data.
- **Compound Wildcard Indexes** — may affect your secondary index strategy.

### MongoDB 8.0 Verification

To verify you're running MongoDB 8.0 and check for version-specific features, run [`scripts/verify_mongodb_version.js`](scripts/verify_mongodb_version.js):

```bash
mongosh "<your-connection-string>" --file scripts/verify_mongodb_version.js
```

## Data Collection Checklist

- [ ] Database and collection statistics collected
- [ ] Operations per second measured during peak hours
- [ ] Workload questionnaire completed
- [ ] Current data size documented
- [ ] Projected data size (12 months) estimated
- [ ] Secondary index counts recorded
- [ ] MongoDB version documented
- [ ] All output saved to files

## What to Provide for Sizing Analysis

Once you've collected the data, please provide:

- Output from the collection scripts (JSON format preferred)
- MongoDB version (especially if running 8.0)
- Peak operations metrics (read ops/sec and write ops/sec)
- Answers to the workload questionnaire
- Current cluster configuration (if on Atlas: tier name, region, etc.)
- Any specific requirements (compliance, latency, geographic distribution)

## Troubleshooting

### Permission Errors

If you encounter permission errors, ensure your user has at least the `clusterMonitor` and `read` roles. Use [`scripts/create_sizing_user.js`](scripts/create_sizing_user.js) as a template (edit the password before running).

### Script Timeout

If a script times out on large deployments:

- Run the scripts per database instead of all at once.
- Increase the `mongosh` timeout: `mongosh --eval "config.set('timeoutMs', 300000)"`.

### MongoDB 8.0 Specific Issues

If you encounter any issues specific to MongoDB 8.0:

- Ensure you're using the latest version of `mongosh` (2.0+).
- Check that your connection string uses the correct authentication mechanism.
- Verify that your user has the necessary permissions for new 8.0 features.

### Atlas Specific

For Atlas clusters, you can also extract metrics from:

- Atlas UI → Metrics tab
- Atlas API: `GET /api/atlas/v1.0/groups/{groupId}/processes/{host}/measurements`

## Questions or Issues?

If you encounter any issues running these scripts or need clarification on any metrics, please reach out with:

- Error messages (if any)
- MongoDB version (especially if 8.0)
- Deployment type (self-hosted, Atlas, etc.)
- Specific questions about the data collection process

## Security Note

⚠️ **Important:** The output from these scripts may contain sensitive information about your database structure. Please:

- Review the output before sharing.
- Redact any sensitive collection or database names if needed.
- Use secure channels to transmit the data.

---

**Version:** 1.1
**Last Updated:** May 2026
**Compatible with:** MongoDB 4.4+, 5.0+, 6.0+, 7.0+, 8.0+