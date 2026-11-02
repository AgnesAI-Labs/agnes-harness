render:
	@test -n "$(SITE)" || { echo "error: SITE is required, run: make render SITE=<name>"; exit 1; }
	@./render.sh "$(SITE)"

.PHONY: render
