.DEFAULT_GOAL := help
.PHONY: help dev dev-web

NODE ?= node
MISE := $(shell command -v mise 2>/dev/null)
ARGS ?=

help:
	@echo "make dev                 rebuild and restart the local AGH backend and Web (port 4189)"
	@echo "                         use the project toolchain via mise when available"
	@echo "make dev ARGS='--help'   show scope and port options"
	@echo "make dev-web             alias for make dev"

dev dev-web:
	$(if $(MISE),"$(MISE)" exec --) $(NODE) tools/dev.mjs $(ARGS)
