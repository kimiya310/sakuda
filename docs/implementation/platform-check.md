# Platform quick check — implementation issue and plan

GitHub Issues are disabled for this repository; this document is the local issue equivalent.

## Scope and acceptance

- Separate logically customer-grouped platform inventory and immutable run snapshots; no changes to Web/API result semantics.
- Explicit IPv4/IPv6/hostnames, selected TCP ports, IPv4 CIDR preview capped at 256 hosts, exclusions applied before enqueue. DNS resolution is frozen and exclusions checked before operator confirmation; no ICMP prerequisite.
- Authorization record (administrator, reference, time window, reachable-segment confirmation), external/LAN/VPN location; low-impact immutable profile only.
- Sequential shared job worker; bounded connect rate, concurrency, probe bytes, total duration, and cancellable queued/running jobs.
- Bounded TCP service banners, direct TLS certificate/config inspection, restricted read-only approved network templates and version-only known vulnerability hints. No UDP, STARTTLS, OS/cloud audit, exploitation, password guessing or DoS.
- Findings explicitly confirmed/inferred/needs-review; coverage stored per endpoint and phase. Missing/failed/changed coverage never resolves previous findings.
- Dedicated UI/history/report; human review required before customer report, separate confirmed/verify/next-support sections. Delete customer group/results and automatic retention.

## Design

Separate platform_groups/platform_runs tables with typed JSON snapshots/results, shared sequential job loop, dedicated platform API and UI. Prefer native bounded TCP/TLS probes over adding nmap (no dependency, no raw sockets or broad service probes). Hostname resolves to exactly one address or is rejected as ambiguous; IP used for all network operations, original hostname retained for TLS SNI. IPv4 CIDR preview is explicit; IPv6 literals supported but IPv6 CIDR deferred.

## Validation and failure scenarios

Only mocked transports/resolvers/tool runners and in-memory SQLite in automated tests. No live internet/LAN scans, no Docker diagnostic runs. Target parser/CIDR/exclusion, authorization/window gates, DNS pinning/exclusion, request budgets, abort/deadline, service/TLS classification, allowlisted templates, partial diff, customer isolation/review/report/deletion/retention, existing regression suite, typecheck/lint/build.

Risks: DNS can resolve excluded destinations → resolve and filter before connecting, never pass hostnames to tools. Missing coverage can appear resolved → per-check completeness and unverified diff bucket. Templates can send unsafe traffic → immutable checked-in read-only templates, no arbitrary template path or risk opt-in. UI is not authentication → loopback bind or authenticated internal reverse proxy is mandatory; not a customer portal.

Stop: initial feature and fresh regression evidence, or explicit remaining validation gaps; never validate by probing third-party targets.

## Reviewed safety corrections / agreed implementation plan

<!-- gh-issue-planner:agreed-plan -->

The architecture review identified the following concrete corrections; implemented contract:

- Registration/explicit preview refresh resolves hostnames before operator confirmation. Exactly one resolved IP per hostname; ambiguous hosts require explicitly selected IP registration. Preview holds IP/port manifest, digest and timestamp; expires after 15 minutes at enqueue. Execution never resolves DNS again. IPv4 CIDR expands with subnet network/broadcast auto-exclusions, then exclusions/address policy rejects unsafe scope. External location accepts public IPs only; all modes reject unspecified, loopback, link-local, mapped IPv6, multicast and potential `.255` broadcast destinations. Location is operator-declared, not inferred.
- Max 256 endpoint pairs, 32 ports, 4 concurrent probes, 5 connections/second; default2. Maximum 512 banner bytes per endpoint, bounded TLS metadata, read-only Redis PING64-byte reply only. Preview estimates maximum work using per-phase request budget, probe timeout, rate and concurrency; oversized work rejected. TCP+TLS are low-impact active probes, not passive scans. No protocol payload unless the operator explicitly approves that endpoint as Redis.
- Coverage is per-phase `done/not-applicable/failed/cancelled/not-run`, with observation notes. IP change, unsupported version/protocol, failure or stop is unverified, never resolution. Host refusal means port closed/reached, not “host unreachable” or remediation proof.
- Per-run abort controllers plus database cancellation flag. Queued cancellation atomic; running transport cancellation immediate locally and polled across process boundaries. DB deletion forbidden until transports finish. Authorization window checked at enqueue and execution, deadline=min(profile,permission-window).
- Immutable embedded Redis PING template, one exact ID and explicit IP:port only; no INFO, credentials, arbitrary paths, community tree, OAST, code/workflow or fallback ports. Nuclei binary pinned to3.11.1 in Docker; custom binary configuration requires operator validation. Curated OpenSSH9.6/CVE-2023-48795 banner hint uses official release/security notes (2023-12-18), always inferred; distributor backports and negotiated cipher/peer support require administrator confirmation. Initial release does not assert exploitability.
- Logical customer groups, not a tenant authorization boundary. Initial operators share a trusted internal deployment; loopback Docker binding or authenticated internal proxy mandatory. No customer portal.
- Retention defaults30days, configurable1–365; terminal results cleaned at boot and hourly while runner enabled. Customer deletion cascades terminal records; active jobs must stop first. No persistent engine raw files; private temporary dirs0700/files0600, discarded logs, removed in finally. Evidence bounded and sanitized, never secrets/raw output in application logs.
- Report download blocked before saved reviewer/name/time/notes/next-support. Draft views internal; confirmed problems separated from inference/additional verification; scope and omitted coverage/disclaimer mandatory.

Official sources: [Nuclei network templates](https://docs.projectdiscovery.io/templates/protocols/network), [Nuclei runtime flags](https://docs.projectdiscovery.io/opensource/nuclei/running), [Redis PING](https://redis.io/docs/latest/commands/PING/), [Redis INFO safety categories](https://redis.io/docs/latest/commands/info/), [OpenSSH9.6 release notes](https://www.openssh.org/releasenotes.html), [OpenSSH security](https://www.openssh.org/security.html).

## Changed-file cleanup plan

Behavior lock: platform domain/service tests21/21 plus engine mock tests18/18 and UI mocked tests are in place. Writer pass (implementation owner) identifies only duplicate preview exposure and redundant pre-DNS digest: remove the unused standalone preview API (registration and group refresh are the supported preview surfaces) and calculate the approval digest only from the resolved manifest. No unrelated refactoring, no dependencies, no compatibility fallback additions. Independently reviewed with the code/design review lanes. Bounded fail-safe branches (unknown service, failed template, invalid dates, cancellation) deliberately retain explicit unverified outcomes and corresponding tests; no silent clean fallback is preserved.

Review corrections: Redis protocol probing now requires a separate explicit `redisPorts` operator approval (empty by default, subset of selected TCP ports, included in the confirmed manifest). Merely choosing TCP6379 does not send PING to an unknown service. Socket reset after a successful TCP connection is recorded as open/reached, not closed. Stopping jobs have cancelled status with no finish timestamp until transports exit; they continue polling and block re-execution, review and deletion. Restart finalizes interrupted stopping jobs. Immutable `sales-tcp-v1` profile is saved in snapshots and different profile revisions cannot resolve old findings. Drizzle snapshot metadata is generated together with the new migration.

Final review repairs: PING is limited exclusively to separately approved `redisPorts` (not automatic banner/port guesses). Work budget counts selected TCP, selected TLS and approved Redis phases; the time estimate conservatively serializes each timeout plus1second overhead. CIDR prefixes≤/30 automatically exclude their network/broadcast endpoints; /31 and /32 retain explicitly confirmed point-to-point semantics. Repeated cancel is idempotent and cannot finish a stopping job. API and SSR platform pages are private/no-store. Related regression tests cover each change. Custom engine version validation and live nuclei/Docker transport smoke remain manual, with no customer/third-party probes run automatically.

## Independent review and validation

Code review: APPROVE, zero open findings. Architecture: CLEAR, no blockers. Cleanup plan approved independently; only duplicate preview exposure/digest were deleted, no new dependency. Automated transport checks remain mocked; API E2E disables the job runner. Real nuclei/Docker-to-service smoke testing is deliberately deferred to an authorized isolated fixture. No primary worktree or shared database was modified.

Final local acceptance (2026-10-09): lint and typecheck PASS; Vitest84files/781tests PASS; API E2E22tests PASS with job runner disabled; production Nuxt build PASS. All platform DNS/socket/TLS/subprocess unit tests use mocks; SQLite tests use isolated memory databases. Docker image/live service diagnostic tests were not run. Code and architecture reviews have no open findings. The feature remains in its dedicated worktree/branch; main is unchanged.
