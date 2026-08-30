# P3 performance evidence

Real measurements only. Legacy comparison is recorded only when an equivalent runner exists.

```json
{
  "generatedAt": "2026-08-30T08:45:23.130Z",
  "command": "cargo test native_smoke_host_origin_p3 --manifest-path src-tauri/Cargo.toml -- --ignored --nocapture",
  "os": "darwin arm64",
  "osVersion": "Darwin 25.6.0",
  "bun": "1.4.0",
  "samples": 20,
  "warmup": 3,
  "percentileAlgorithm": "nearest-rank (ceil(p*n)-1), sorted elapsed milliseconds",
  "fixture": "one temporary registered workspace, one primary native runtime, one session, real embedded Pi",
  "native": {
    "hostOriginSnapshot": {
      "p50Ms": 2.67,
      "p95Ms": 5.04,
      "valuesMs": [
        2.852083,
        2.472041,
        2.685709,
        2.929333,
        2.6610829999999996,
        3.156833,
        2.726375,
        2.594625,
        2.6735,
        2.6293330000000004,
        2.646208,
        2.513417,
        12.406208,
        2.439958,
        5.043792,
        2.834,
        2.4907079999999997,
        2.6680829999999998,
        2.648959,
        2.9026669999999997
      ]
    },
    "promptToFirstEvent": {
      "p50Ms": 97.72,
      "p95Ms": 98.51,
      "valuesMs": [
        97.689292,
        98.176125,
        98.247625,
        97.200833,
        97.73633299999999,
        97.1255,
        98.29325,
        98.249833,
        97.721959,
        98.004625,
        97.569042,
        141.506584,
        88.75175,
        98.395959,
        95.78716700000001,
        97.12283400000001,
        98.112625,
        97.353541,
        98.511875,
        57.964915999999995
      ]
    },
    "shellMs": 1.317541,
    "bootstrapMs": 0.764541
  },
  "legacy": {
    "status": "not-run",
    "blocker": "No equivalent legacy fixture runner is available in repository. scripts/perf-baseline.mjs only measures an already-running Pi-origin server, while this harness creates and owns temporary workspace, session, model interaction, and cleanup; comparing it would violate same-fixture/equivalence requirement."
  }
}
```
