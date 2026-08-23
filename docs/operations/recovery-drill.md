# Offline Gateway Recovery Drill

This tabletop drill describes how an operator would verify and recover the local telemetry path after a connectivity interruption. It is a documentation and test-design artifact; it is not permission to operate physical equipment.

## Scenario

The site loses upstream connectivity while local telemetry continues. The gateway must retain validated readings, retry safely after connectivity returns, and preserve evidence needed to explain the recovery.

## Safety boundary

- Do not switch grid, generator, battery, or load equipment as part of this drill.
- Do not connect the current software to safety-critical controls.
- Stop if a step would require unreviewed credentials, destructive database changes, or physical actuation.
- Use synthetic scenarios and a disposable local database for the exercise.

## Preflight evidence

Record before starting:

- repository commit and Node.js version;
- selected simulator scenario and seed;
- test database path and backup location;
- gateway sequence state and outbox row count;
- expected transport state;
- operator name, start time, and review partner.

## Exercise steps

1. Run the normal-day scenario and verify that envelopes pass contract validation.
2. Capture the starting gateway sequence and confirm that the outbox is empty.
3. Make the test transport unavailable without modifying physical systems.
4. Run the outage/restore scenario and confirm that validated readings accumulate locally.
5. Restart the gateway process and verify that the SQLite outbox still contains the queued evidence.
6. Restore the test transport and prepare the next ordered batch.
7. Apply the acknowledgement and verify that only acknowledged rows are removed.
8. Replay the acknowledgement to confirm idempotent behavior.
9. Compare the received sequence range with the locally generated range and document any gap.
10. Return the test environment to the normal state and retain the drill record.

## Verification checklist

- [ ] No synthetic reading was silently dropped.
- [ ] Sequence numbers remained monotonic.
- [ ] Retry behavior stayed within configured bounds.
- [ ] Duplicate acknowledgements did not corrupt outbox state.
- [ ] Restarting the process did not erase queued readings.
- [ ] Origin, quality, and derivation metadata remained intact.
- [ ] Logs and operator notes identify each state transition.
- [ ] No physical or safety-critical action occurred.

## Drill record

Capture:

- result: pass, pass with observations, or fail;
- failed checkpoint and visible evidence;
- recovery action taken;
- files or logs retained;
- follow-up issue and owner;
- reviewer sign-off.

## Escalation rule

If validation, sequence continuity, durability, or acknowledgement behavior cannot be explained from the recorded evidence, preserve the database and logs, stop the exercise, and open an issue before attempting another recovery path.
