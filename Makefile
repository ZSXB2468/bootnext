NAME=bootnext
DOMAIN=local
BRANCH=$(shell git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "snapshot")

.PHONY: all pack install install-manual clean compile-po

all: dist/extension.js

node_modules: package.json
	npm install

dist/extension.js: node_modules
	@ ./node_modules/typescript/bin/tsc

compile-po:
	@for file in po/*.po; do \
		[ -f "$$file" ] || continue; \
		mkdir -p dist/locale/$$(basename $$file .po)/LC_MESSAGES; \
		msgfmt -o dist/locale/$$(basename $$file .po)/LC_MESSAGES/$(NAME)@$(DOMAIN).mo $$file; \
	done

$(NAME)@$(DOMAIN).zip: dist/extension.js
	@cp src/metadata.json dist/
	@cp -r schemas dist/
	@$(MAKE) compile-po
	@(cd dist && zip ../$(NAME)@$(DOMAIN)-$(shell date +%Y%m%d)$(if $(filter dev,$(BRANCH)),-$(BRANCH)).zip -9r .)

pack: $(NAME)@$(DOMAIN).zip

install: $(NAME)@$(DOMAIN).zip
	@ZIP=$$(ls -t $(NAME)@$(DOMAIN)-*.zip 2>/dev/null | head -1); \
	gnome-extensions install --force "$$ZIP" 2>/dev/null && \
		echo "Extension installed & loaded (gnome-extensions)." || \
		echo "gnome-extensions failed. Try: make install-manual"
	@glib-compile-schemas ~/.local/share/gnome-shell/extensions/$(NAME)@$(DOMAIN)/schemas/ 2>/dev/null || true

install-manual: $(NAME)@$(DOMAIN).zip
	@[ -d ~/.local/share/gnome-shell/extensions ] || mkdir -p ~/.local/share/gnome-shell/extensions
	@rm -rf ~/.local/share/gnome-shell/extensions/$(NAME)@$(DOMAIN)
	@cp -r dist ~/.local/share/gnome-shell/extensions/$(NAME)@$(DOMAIN)
	@glib-compile-schemas ~/.local/share/gnome-shell/extensions/$(NAME)@$(DOMAIN)/schemas/ 2>/dev/null || true
	@echo "Extension installed (manual). Restart GNOME Shell (Alt+F2, r) to activate."

clean:
	@rm -rf dist node_modules $(NAME)@$(DOMAIN)-*.zip
