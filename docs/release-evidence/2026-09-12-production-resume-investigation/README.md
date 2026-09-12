# Production resume investigation — 12 September 2026 UTC

Production publication is incomplete. No Netlify publication occurred in either run below.

## Verified observations

- [Rehearsal 34692663121](https://github.com/schalkneethling/ephemeral-pages/actions/runs/34692663121) passed for candidate `ef61989f04a1c056bcf7d4fba7f9f181d1fea3cc`. Promotion PR #66 merged as `b2b18d675bbce7348f641ad269a712f19b976105` with the same tree; exact-main CI passed.
- [Production 34693466555](https://github.com/schalkneethling/ephemeral-pages/actions/runs/34693466555) held Netlify deployment `6aa5442e8dda57e9d0139e83`, activated Worker version `e0797b73-b0eb-4c04-814c-12b75314a587` under deployment `1dec3828-8424-4a9a-9217-5406b22bf72a`, and passed the transition smoke. The prepublication check failed with diagnostic `cloudflare / versionView / command / timeout`. The CLI remained running after persisting failure; normal cancellation allowed evidence upload.
- [Resume 34694123592](https://github.com/schalkneethling/ephemeral-pages/actions/runs/34694123592) passed preflight, then failed during initial inspection before any new mutation. Its retained `unknown` classification did not identify the local artifact validation failure.
- Netlify retains the previously published deployment `6aa43cfb4b7bde0008cfc4d9`. The retained production record shows a mixed old-app/new-Worker pair, not a completed release.

The original production archive was verified against digest `sha256:3a16b078a995521a61a5d289c734ffcf9f47e4d0b0fd959e5e47e733018393a6` (artifact `10298522080`). The resume archive was verified against digest `sha256:e4cedd2436c1df13954b0ad1d8fe83dfd0f0646d4a7db782d23fd0069139d832` (artifact `10297757224`). Both are temporary GitHub artifacts, not permanent recovery guarantees.

## Reproduced cause

The generic GitHub artifact extractor creates private writable files and directories (0600/0700). Production resume moves the extracted artifact tree into its workspace without restoring the sealed artifact permissions. The Netlify artifact verifier requires read-only files and directories and rejects this tree before provider inspection.

The actual provider factory reproduced the failure against the downloaded resume artifact. In a separate offline copy, changing only artifact permissions to 0400/0500 made the actual Netlify artifact verifier pass with the original manifest and content hashes unchanged. This establishes a deterministic resume defect; it does not establish why the earlier Cloudflare read command timed out.

## Repair and release boundary

Repair must validate retained structure and hashes, seal only the expected artifact trees, then run the normal verifier. Generic extraction must remain unchanged. Failure records must identify artifact validation and subprocess causes without retaining secret-bearing payloads; the CLI must flush its final report and terminate after awaited work completes.

Changing the protected release runner changes the candidate. Do not weaken same-commit resume checks or reuse the old approval for modified code. After a reviewed repair, the supported recovery operation can verify the historical failed source and recorded prior target. A fresh rehearsal and promotion are required afterward. Recovery and the repaired release remain unverified until their live workflows pass.

## Offline repair validation

The integrated repair passed 119 tests across six focused suites, Vite+ checks, release typecheck, and Gitleaks history/worktree scans. The extraction regression validates real archive extraction and rejects changed content before sealing. Separate copies of the actual failed source and adoption recovery-target artifacts passed restoration and strict Netlify/Worker verification. Independent review found no blocker. These checks validate the repair offline; they do not claim a successful production recovery or completed application release.

Review follow-up adds explicit inventory-path containment before filesystem access and permits a recovered deployment ID for an unchanged adopted Worker version. Its integrated checks passed 101 tests; the path-escape regression fails without the fix, and both real retained bundles pass strict restoration. A local real-functions packaging fixture failure also reproduces on unchanged base `4eea778`; it is not attributed to this repair.

## Recovery source and debug-rerun follow-up

Recovery `34698033756` selected original run `34693466555`, but the history verifier
requires the latest unresolved attempt, `34694123592`. A read-only replay of the
original invocation reproduced the stale-source rejection; the complete preflight
passed with `34694123592` and its actual retained artifacts. Only execution-time
invocation metadata was simulated; no provider mutation was performed.

The subsequent debug rerun made run `34698033756` attempt 2. The existing history
check rejected any prior rerun before inspecting its steps. The repair skips such
history only after every attempt proves that the sole production job completed
unsuccessfully and all deployment steps were skipped. A read-only history check
against the actual attempt-one and attempt-two jobs selected `34694123592` and
skipped `34698033756`. Production recovery remains outstanding until its workflow
passes. The generic preflight error remains a separate diagnostic improvement.
