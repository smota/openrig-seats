# Seat readers

Native session discovery returns validated realpaths. Use `readAgySession` or
`readPiSession` to read those files; these helpers open with `O_NOFOLLOW` where
available and verify the opened descriptor is a regular file before reading.
The readers' synchronous `follow` methods parse supplied generation records and
do not open files themselves.

## Threat model

Readers run as the same OS user who owns the harness directories. An attacker
who can write to those directories already controls the user's sessions, so a
race against such an attacker is out of scope. Discovery refuses symlinked
roots and out-of-base files to stop accidental or configuration escapes.
