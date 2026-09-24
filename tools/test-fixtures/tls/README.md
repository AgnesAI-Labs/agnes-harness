# Public TLS test fixture

These files contain a newly generated, synthetic RSA key and a self-signed certificate.
The key is deliberately public test data, not a credential for any service. Never use
it for a deployed listener or add this certificate to a system trust store.

The certificate covers only `127.0.0.1` and is valid from 2020-01-01 to 2120-01-01.
Tests read the files directly, so Windows, macOS and Linux do not need an `openssl`
executable to run TLS checks. The SDK test must reject the default connection and
accept a connection only when this certificate is passed explicitly as its CA.

Generated once using Python cryptography 50.0.0: RSA 2048, exponent 65537, random
serial, SHA-256 signature, PKCS#8 unencrypted PEM key, IP subject alternative name,
and critical BasicConstraints CA=true/path_length=0. Python and cryptography are
not runtime or test dependencies; regeneration is only needed when replacing this
fixture. Replace the key and certificate together and rerun the TLS tests.

Certificate SHA-256 fingerprint:
`e08217f095b1df085bf8f80c543f8e7d36910db82e044e9c8d587d20c5053aab`.
