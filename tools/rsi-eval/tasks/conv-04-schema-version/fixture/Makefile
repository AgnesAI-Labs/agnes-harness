check:
	@bash scripts/check.sh

db: check
	@mkdir -p build
	@python3 scripts/apply.py build/app.sqlite3

.PHONY: check db
