import sys

for _ in range(256):
    sys.stdout.buffer.write(b"x" * 8192)
    sys.stderr.buffer.write(b"y" * 8192)
