#!/bin/sh
set -e

cli_target=''
for candidate in \
  '/opt/DiffDash/resources/bin/diffdash' \
  '/opt/diffdash/resources/bin/diffdash' \
  '/usr/lib/diffdash/resources/bin/diffdash'
do
  if [ -f "$candidate" ]; then
    cli_target="$candidate"
    break
  fi
done

if [ -z "$cli_target" ]; then
  exit 0
fi

chmod 755 "$cli_target"
ln -sfn "$cli_target" /usr/bin/diffdash
