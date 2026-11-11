#!/bin/sh
# Generates a throwaway certificate chain shaped like Apple's (P-384 root and intermediate with the WWDR marker
# extension, P-256 leaf with the App Store marker) for the JWS tests: test/fixtures/apple-test-chain.json.
set -e
d=$(mktemp -d)
cd "$d"
openssl ecparam -name secp384r1 -genkey -noout -out root.key
openssl req -x509 -new -key root.key -sha384 -days 36500 -subj "/CN=Revflare Test Root" -out root.pem
openssl ecparam -name secp384r1 -genkey -noout -out int.key
openssl req -new -key int.key -subj "/CN=Revflare Test Intermediate" -out int.csr
printf "basicConstraints=critical,CA:TRUE\n1.2.840.113635.100.6.2.1=ASN1:NULL\n" > int.ext
openssl x509 -req -in int.csr -CA root.pem -CAkey root.key -CAcreateserial -sha384 -days 36500 -extfile int.ext -out int.pem
openssl ecparam -name prime256v1 -genkey -noout -out leaf.key
openssl req -new -key leaf.key -subj "/CN=Revflare Test Leaf" -out leaf.csr
printf "1.2.840.113635.100.6.11.1=ASN1:NULL\n" > leaf.ext
openssl x509 -req -in leaf.csr -CA int.pem -CAkey int.key -CAcreateserial -sha384 -days 36500 -extfile leaf.ext -out leaf.pem
openssl pkcs8 -topk8 -nocrypt -in leaf.key -out leaf.p8
b64() { openssl x509 -in "$1" -outform der | base64 | tr -d '\n'; }
printf '{\n  "root": "%s",\n  "intermediate": "%s",\n  "leaf": "%s",\n  "leafKey": "%s"\n}\n' "$(b64 root.pem)" "$(b64 int.pem)" "$(b64 leaf.pem)" "$(grep -v -- ----- leaf.p8 | tr -d '\n')"
