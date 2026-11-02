index:
	@bash scripts/genindex.sh

test:
	@bash scripts/verify.sh
	@for f in plugins/*.sh; do bash run.sh "$$(basename $$f .sh)" smoke >/dev/null || exit 1; done
	@echo "tests ok"

.PHONY: index test
