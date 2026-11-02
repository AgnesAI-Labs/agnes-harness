#!/usr/bin/env python3
import configparser
import os
import sys

if len(sys.argv) != 2:
    print('usage: python3 run.py <section>', file=sys.stderr)
    sys.exit(2)

if not os.path.isfile('config.ini'):
    print('error: config.ini not found in the current directory; run this from the service/ directory', file=sys.stderr)
    sys.exit(1)

config = configparser.ConfigParser()
config.read('config.ini')
section = sys.argv[1]
if section not in config:
    print(f'error: unknown section {section}', file=sys.stderr)
    sys.exit(1)
for key, value in config[section].items():
    print(f'{key}: {value}')
