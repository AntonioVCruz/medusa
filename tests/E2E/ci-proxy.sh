#!/usr/bin/env bash
set -euo pipefail
umask 077
state=tests/E2E/.runtime
tls="$state/tls"
pidfile="$state/ci-proxy.pid"

stop() {
  if [[ -f "$pidfile" ]]; then
    proxy_pid=$(cat "$pidfile")
    if [[ -r "/proc/$proxy_pid/cmdline" ]] && tr '\0' ' ' < "/proc/$proxy_pid/cmdline" | grep -Fq 'tests/E2E/ci-proxy.py'; then
      kill "$proxy_pid"
      for ((attempt=0; attempt<30; attempt++)); do
        kill -0 "$proxy_pid" 2>/dev/null || break
        sleep 0.1
      done
    fi
    rm -f "$pidfile"
  fi
}

case "${1:-https}" in
  stop) stop; exit ;;
  https|http) protocol=$1 ;;
  *) echo 'Usage: ci-proxy.sh {https|http|stop}' >&2; exit 2 ;;
esac
stop
mkdir -p "$tls" "$state/ci-raw"
if [[ ! -f "$tls/cert.pem" ]]; then
  openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 1 \
    -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost' \
    -keyout "$tls/key.pem" -out "$tls/cert.pem" \
    > "$state/ci-raw/tls-generation.log" 2>&1
  chmod 600 "$tls/key.pem"
fi
openssl x509 -in "$tls/cert.pem" -noout -subject -ext subjectAltName \
  > "$state/ci-raw/tls-certificate.txt"
python3 tests/E2E/ci-proxy.py --protocol "$protocol" \
  --cert "$tls/cert.pem" --key "$tls/key.pem" \
  > "$state/ci-raw/proxy-$protocol.log" 2>&1 &
echo "$!" > "$pidfile"
for ((attempt=0; attempt<30; attempt++)); do
  if curl --noproxy '*' --cacert "$tls/cert.pem" --connect-timeout 2 --max-time 5 \
    --fail --silent "$protocol://localhost:18443/health" > /dev/null; then
    exit
  fi
  sleep 1
done
echo 'CI proxy failed readiness' >&2
exit 1
