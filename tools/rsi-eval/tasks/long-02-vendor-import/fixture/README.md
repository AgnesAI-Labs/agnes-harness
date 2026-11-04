# Warehouse imports

Vendors (acme, bolt) send files that land in `drops/`. Each file starts with one header line.
`bin/ingest` is the import tool (`bin/ingest help`).

To import a file: `bin/ingest load <table> <file>` stages it as a batch and prints the batch number,
then `bin/ingest commit <batch>` adds the batch to the table. `bin/ingest total <table>` counts what a
table holds; `bin/ingest batches` lists the batches.
