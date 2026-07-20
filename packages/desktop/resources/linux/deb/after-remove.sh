#!/bin/sh
set -e

link_path='/usr/bin/diffdash'

if [ ! -L "$link_path" ]; then
  exit 0
fi

link_target="$(readlink "$link_path")"
case "$link_target" in
  '/opt/DiffDash/resources/bin/diffdash'|'/opt/diffdash/resources/bin/diffdash'|'/usr/lib/diffdash/resources/bin/diffdash')
    rm -f "$link_path"
    ;;
esac
