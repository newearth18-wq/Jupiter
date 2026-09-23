# Environments

| Environment | Purpose                         | Build channel                 | Secret policy                            |
| ----------- | ------------------------------- | ----------------------------- | ---------------------------------------- |
| development | local Electron/Vite development | development                   | local overrides only; never commit       |
| test        | isolated automated tests        | test                          | synthetic non-secret fixtures only       |
| production  | packaged desktop application    | stable unless CI overrides it | Windows DPAPI via Electron `safeStorage` |

Tracked `.env.*` files contain non-secret mode labels only. Machine-specific values belong in ignored `.env.*.local` files. Production credentials must never be supplied through committed environment files.
