# Warehouse imports

Vendors (acme, bolt) send files that land in `drops/`. Each file starts with one header line.
`bin/ingest` is the import tool (`bin/ingest help`).

To import a file: `bin/ingest load <table> <file>` stages it as a batch and prints the batch number,
then `bin/ingest commit <batch>` adds the batch to the table. `bin/ingest total <table>` counts what a
table holds; `bin/ingest batches` lists the batches.

Keep converted copies and other scratch files inside this project, for example under `scratch/`: the
sandbox the tools run in does not let you write anywhere else.
