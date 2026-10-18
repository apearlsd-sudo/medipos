#!/bin/bash
# keeps the fake S3 alive across flaky reapers; logs to /tmp
while true; do
  python3 /home/z/my-project/scripts/fake-s3.py >> /tmp/fake-s3.log 2>&1
  echo "[supervisor] fake-s3 exited ($?) — respawning" >> /tmp/fake-s3.log
  sleep 0.3
done
