# MHS browser client

The MHS plugin's browser module uses public Agnes client registries and owner-bound profile services and streams. It has no device sockets, credentials, storage, approval decisions or Hub lifecycle authority.

`MhsPorts` is the presentation adapter boundary. Profile queries/effects and authenticated streams follow the public Host contracts; effects return operation receipts. The package supplying the MHS backend binds these adapters and contributes the module with a profile lifetime, declared `mhs` primary home entry and exact service/stream allowlists. Unsupported Hosts must reject activation rather than bypass native approval or open a direct device WebSocket.

Developer diagnostics and local example contributions are optional adapters. A missing contribution is shown as unavailable. Example activation and launch retain the host's native package review and bounded launch flow; a scene is a resolved local component, never an arbitrary iframe.
