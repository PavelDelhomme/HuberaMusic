# PLM — commandes locales & déploiement (style JobbingTrack)
# Usage : make help

.DEFAULT_GOAL := help
SHELL := /bin/bash
ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))

# Couleurs (comme JobbingTrack)
C_CYAN  := \033[0;36m
C_GREEN := \033[0;32m
C_YELL  := \033[1;33m
C_DIM   := \033[0;90m
C_BOLD  := \033[1m
C_RESET := \033[0m

DEVICE ?= R5CT7263YJL
# Multi-appareils ADB Wi‑Fi / batterie (séparés par virgule). Ex: DEVICES=R5CT7263YJL,00145153K001434
DEVICES ?=
DURATION ?= 1800
SAMPLE_SECS ?= 15

.PHONY: help install seed-users test-verify-email env-check \
	dev up up-full down down-clean restart restart-api ensure-api \
	dev-server dev-web build start deploy-local clean-vite icons \
	docker-dev docker-dev-down docker-build \
	mobile-qr mobile-hint mobile-adb mobile-install-adb test-register-adb \
	android-sync android-build android-install android-logs android-publish android-upload-apk android-prod android \
	android-capacitor android-capacitor-prod adb-fix \
	adb-fix-keys \
	adb-wifi adb-wifi-connect adb-wifi-status adb-wifi-wait-unplug adb-wifi-disconnect \
	adb-wifi-doctor adb-wifi-ensure adb-wifi-pair adb-both adb-devices \
	battery-go battery-go-calm battery-suite \
	battery-test battery-test-short battery-report battery-report-mail \
	update-apps status status-watch \
	link-home-stream link-home-stream-status link-home-stream-stop \
	logs logs-tail logs-watch logs-history logs-archive \
	db-status db-backup \
	ports kill-dev push-dev push-prod deploy-hint \
	bump-patch bump-minor bump-major version

help: ## Affiche cette aide colorée
	@echo ""
	@printf "$(C_BOLD)  PLM — make targets$(C_RESET)\n"
	@echo "  ======================"
	@echo ""
	@printf "  $(C_GREEN)▶ Démarrage$(C_RESET)\n"
	@grep -E '^(up|up-full|down|down-clean|restart|dev|ensure-api|restart-api|dev-server|dev-web):.*?##' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "    $(C_CYAN)%-20s$(C_RESET) %s\n", $$1, $$2}'
	@echo ""
	@printf "  $(C_GREEN)▶ Logs & statut$(C_RESET)\n"
	@grep -E '^(status|status-watch|logs|logs-tail|logs-watch|logs-history|logs-archive|ports):.*?##' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "    $(C_CYAN)%-20s$(C_RESET) %s\n", $$1, $$2}'
	@echo ""
	@printf "  $(C_GREEN)▶ Base de données$(C_RESET)\n"
	@grep -E '^(db-status|db-backup|seed-users):.*?##' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "    $(C_CYAN)%-20s$(C_RESET) %s\n", $$1, $$2}'
	@printf "  $(C_GREEN)▶ Mobile Android$(C_RESET)\n"
	@grep -E '^(android|android-prod|android-install|android-build|android-logs|android-publish|android-upload-apk|mobile-[^:]+:|adb-[^:]+:|battery-[^:]+:).*?##' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "    $(C_CYAN)%-28s$(C_RESET) %s\n", $$1, $$2}'
	@echo ""
	@printf "  $(C_GREEN)▶ Build / Docker / Git$(C_RESET)\n"
	@grep -E '^(install|build|start|deploy-local|docker-|icons|clean-vite|env-check|push-|deploy-hint|update-apps|test-|bump-|version):.*?##' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "    $(C_CYAN)%-20s$(C_RESET) %s\n", $$1, $$2}'
	@echo ""
	@printf "  $(C_DIM)Prod        : voir PUBLIC_API_URL / DEPLOY_URL dans .env$(C_RESET)\n"
	@printf "  $(C_DIM)Dev local    : make up-full  ·  make logs  ·  make android$(C_RESET)\n"
	@printf "  $(C_DIM)ADB dual     : make adb-both  (Samsung DEV + Nothing PROD)$(C_RESET)\n"
	@printf "  $(C_DIM)Batterie     : make battery-go  (ensure Wi‑Fi → 30 min → rapport)$(C_RESET)\n"
	@printf "  $(C_DIM)Prod stream : make link-home-stream  (tunnel maison si VPS bloqué YT)$(C_RESET)\n"
	@printf "  $(C_DIM)Suivi        : STATUS.md  ·  TESTS.md  ·  make status-watch$(C_RESET)\n"
	@printf "  $(C_DIM)Branches     : feat/* depuis dev → merge prod$(C_RESET)\n"
	@printf "  $(C_DIM)Version      : d+X.Y.Z (local/dev) · p+X.Y.Z (prod) — make bump-patch|minor|major$(C_RESET)\n"
	@echo ""

# ---------------------------------------------------------------------------
# Démarrage
# ---------------------------------------------------------------------------

install: ## Installe les dépendances (workspaces api + web)
	cd $(ROOT) && npm install

seed-users: ## Crée/maj comptes SEED_* (SEED_PASSWORD dans .env)
	cd $(ROOT) && node scripts/dev/seed-users.mjs

test-verify-email: ## Teste validation email (API locale)
	cd $(ROOT) && node scripts/test/test-verify-email.mjs

test-search: ## Batterie tests recherche (ranking + live YouTube)
	cd $(ROOT) && npx tsx scripts/test/test-search.mjs

env-check: ## Vérifie que .env et .env.example ont les mêmes clés
	@chmod +x $(ROOT)/scripts/dev/env-check.sh
	@bash $(ROOT)/scripts/dev/env-check.sh

dev: ## API (ensure) + Vite au premier plan — logs ytmusic-dev.log
	@chmod +x $(ROOT)/scripts/dev/ensure-api.sh $(ROOT)/scripts/dev/kill-dev.sh $(ROOT)/scripts/dev/env-check.sh
	@bash $(ROOT)/scripts/dev/env-check.sh || true
	@FORCE_RESTART=0 bash $(ROOT)/scripts/dev/ensure-api.sh
	@bash $(ROOT)/scripts/dev/kill-dev.sh vite-only
	@mkdir -p $(ROOT)/logs
	@printf "$(C_YELL)📝 Logs → $(ROOT)/logs/ytmusic-dev.log  ·  suivi : make logs$(C_RESET)\n"
	@echo "   API :8787 (ensure-api) + Vite :5173 uniquement"
	@echo "   Astuce fond : make up / make up-full"
	cd $(ROOT) && npm run dev:web 2>&1 | tee -a $(ROOT)/logs/ytmusic-dev.log

up: ## API + Vite en fond (setsid) — terminal libre
	@chmod +x $(ROOT)/scripts/dev/dev-up.sh
	@bash $(ROOT)/scripts/dev/dev-up.sh
	@printf '%s\n' up > "$(ROOT)/.ytmusic-stack-mode" 2>/dev/null || true

up-full: ## Reset propre + API + Vite + status (+ seed optionnel)
	@printf "$(C_BOLD)🚀 up-full PLM$(C_RESET)\n"
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@chmod +x $(ROOT)/scripts/dev/kill-dev.sh $(ROOT)/scripts/dev/dev-up.sh $(ROOT)/scripts/dev/env-check.sh
	@bash $(ROOT)/scripts/dev/env-check.sh || true
	@bash $(ROOT)/scripts/dev/kill-dev.sh || true
	@mkdir -p $(ROOT)/logs $(ROOT)/data
	@bash $(ROOT)/scripts/dev/dev-up.sh
	@printf '%s\n' up-full > "$(ROOT)/.ytmusic-stack-mode" 2>/dev/null || true
	@echo ""
	@$(MAKE) --no-print-directory status
	@echo ""
	@printf "$(C_GREEN)✅ up-full OK$(C_RESET) — web http://127.0.0.1:5173  ·  api :8787\n"
	@printf "$(C_DIM)   make logs · make android · make db-status$(C_RESET)\n"

down: ## Arrête API + Vite locaux (données SQLite intactes)
	@chmod +x $(ROOT)/scripts/dev/kill-dev.sh
	@bash $(ROOT)/scripts/dev/kill-dev.sh
	@rm -f "$(ROOT)/.ytmusic-stack-mode"
	@printf "$(C_GREEN)✅ Stack locale arrêtée$(C_RESET) (data/ytmusic.db conservée)\n"

down-clean: ## Arrêt + archive logs (DB intacte)
	@$(MAKE) --no-print-directory logs-archive || true
	@$(MAKE) --no-print-directory down

restart: ## down + up-full
	@$(MAKE) --no-print-directory down
	@$(MAKE) --no-print-directory up-full

dev-server: ## API seule — réutilise :8787 si déjà UP
	@chmod +x $(ROOT)/scripts/dev/ensure-api.sh
	@bash $(ROOT)/scripts/dev/ensure-api.sh
	@echo "   Relancer de force : make restart-api · logs : make logs"

ensure-api: ## Garantit l’API :8787 (réutilise si UP)
	@chmod +x $(ROOT)/scripts/dev/ensure-api.sh
	@bash $(ROOT)/scripts/dev/ensure-api.sh

restart-api: ## Tue :8787 puis relance l’API en fond
	@chmod +x $(ROOT)/scripts/dev/ensure-api.sh
	@FORCE_RESTART=1 bash $(ROOT)/scripts/dev/ensure-api.sh

dev-web: ## Frontend Vite seul (port 5173)
	@chmod +x $(ROOT)/scripts/dev/kill-dev.sh
	@bash $(ROOT)/scripts/dev/kill-dev.sh vite-only
	@mkdir -p $(ROOT)/logs
	cd $(ROOT) && npm run dev:web 2>&1 | tee -a $(ROOT)/logs/ytmusic-web.log

build: ## Build production du client (PWA)
	cd $(ROOT) && npm run build

start: ## Démarre le serveur qui sert API + web/dist
	cd $(ROOT) && npm start

deploy-local: ## build + start (prod locale sans Docker)
	cd $(ROOT) && npm run deploy:local

clean-vite: ## Vide le cache Vite (fix 504 Outdated Optimize Dep)
	rm -rf $(ROOT)/web/node_modules/.vite \
	       $(ROOT)/node_modules/.vite \
	       $(ROOT)/node_modules/web/node_modules/.vite 2>/dev/null || true
	@echo "Cache Vite nettoyé — relance : make up"

icons: ## Régénère les icônes PWA (PNG) depuis favicon.svg
	@command -v rsvg-convert >/dev/null || (echo "installe librsvg (rsvg-convert)" && exit 1)
	cd $(ROOT)/web/public && \
	  rsvg-convert -w 192 -h 192 favicon.svg -o icon-192.png && \
	  rsvg-convert -w 512 -h 512 favicon.svg -o icon-512.png && \
	  rsvg-convert -w 180 -h 180 favicon.svg -o apple-touch-icon.png && \
	  python3 $(ROOT)/scripts/dev/make-maskable-icons.py
	@echo "Icônes OK dans web/public/"

docker-dev: ## Conteneurs locaux (+ Mailhog :8025)
	cd $(ROOT) && npm run docker:dev

docker-dev-down: ## Stoppe les conteneurs dev
	cd $(ROOT) && npm run docker:dev:down

docker-build: ## Build image Docker locale
	cd $(ROOT) && npm run docker:build

# ---------------------------------------------------------------------------
# Mobile
# ---------------------------------------------------------------------------

mobile-hint: ## Affiche comment installer l’app mobile (APK + PWA)
	@echo ""
	@echo "  PLM sur téléphone Android"
	@echo "  -----------------------------"
	@echo "  App Kotlin native (Compose + ExoPlayer) :"
	@echo "    make android                      # API locale :8787"
	@echo "    make android                      # APK DEV (LAN) → package .dev"
	@echo "    make android-prod                 # APK PROD → package principal + publish"
	@echo "    API_BASE_URL=http://IP:8787 make android-install"
	@echo ""
	@echo "  Legacy Capacitor (WebView) : make android-capacitor"
	@echo "  PWA (navigateur)           : make mobile-install-adb"
	@echo ""

mobile-qr: ## Liste les URLs d’accès LAN pour le mobile
	@echo "URLs utiles :"
	@echo "  http://localhost:5173  (via make mobile-install-adb + adb reverse)"
	@IP=$$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($$i=="src") {print $$(i+1); exit}}'); \
	if [ -n "$$IP" ]; then echo "  http://$$IP:5173  (Wi‑Fi LAN)"; fi
	@echo "  prod : \$$PUBLIC_API_URL / \$$DEPLOY_URL (.env)"
	@echo ""
	@echo "Préféré USB : make mobile-install-adb DEVICE=$(DEVICE)"

mobile-adb: ## Ouvre PLM sur le device (adb reverse + Chrome)
	@chmod +x $(ROOT)/scripts/android/mobile-install-adb.sh
	@DEVICE="$(DEVICE)" bash $(ROOT)/scripts/android/mobile-install-adb.sh open

mobile-install-adb: ## Installe la PWA sur le device (reverse + Chrome ?install=1)
	@chmod +x $(ROOT)/scripts/android/mobile-install-adb.sh
	@DEVICE="$(DEVICE)" bash $(ROOT)/scripts/android/mobile-install-adb.sh install

android-sync: ## Sync Capacitor legacy (sans rebuild APK)
	@chmod +x $(ROOT)/scripts/android/android-install.sh
	@DEVICE="$(DEVICE)" VITE_API_ORIGIN="$(VITE_API_ORIGIN)" bash $(ROOT)/scripts/android/android-install.sh sync

android-build: ## Compile l’APK Kotlin (Compose / Media3)
	@chmod +x $(ROOT)/scripts/android/kotlin-android-install.sh
	@DEVICE="$(DEVICE)" API_BASE_URL="$(or $(API_BASE_URL),$(or $(VITE_API_ORIGIN),http://127.0.0.1:8787))" bash $(ROOT)/scripts/android/kotlin-android-install.sh build

android-install: ## Build + installe l’APK Kotlin (ADB) — ensure-api
	@chmod +x $(ROOT)/scripts/android/kotlin-android-install.sh $(ROOT)/scripts/dev/ensure-api.sh
	@bash $(ROOT)/scripts/dev/ensure-api.sh
	@DEVICE="$(DEVICE)" API_BASE_URL="$(or $(API_BASE_URL),$(or $(VITE_API_ORIGIN),http://127.0.0.1:8787))" bash $(ROOT)/scripts/android/kotlin-android-install.sh install

android-logs: ## Pull crashes + journal APK → logs/android/ (dev)
	@chmod +x $(ROOT)/scripts/android/android-pull-logs.sh
	@DEVICE="$(DEVICE)" bash $(ROOT)/scripts/android/android-pull-logs.sh

android-publish: ## Compile APK + publie pour /api/deploy/apk (Admin QR)
	@chmod +x $(ROOT)/scripts/android/android-publish-apk.sh
	@API_BASE_URL="$(or $(API_BASE_URL),)" bash $(ROOT)/scripts/android/android-publish-apk.sh

android-upload-apk: ## Build APK prod + upload vers Portainer (Admin QR en ligne)
	@chmod +x $(ROOT)/scripts/android/publish-apk-remote.sh $(ROOT)/scripts/android/android-publish-apk.sh
	@API_BASE_URL="$(or $(API_BASE_URL),$(PUBLIC_API_URL))" \
	 DEPLOY_URL="$(or $(DEPLOY_URL),$(or $(PUBLIC_API_URL),$(APP_URL)))" \
	 bash $(ROOT)/scripts/android/publish-apk-remote.sh

android: ## Raccourci : ensure-api + APK Kotlin native
	@$(MAKE) android-install DEVICE="$(DEVICE)" API_BASE_URL="$(or $(API_BASE_URL),$(or $(VITE_API_ORIGIN),http://127.0.0.1:8787))"

adb-fix: ## Répare ADB unauthorized (diagnostic + reset USB)
	@chmod +x $(ROOT)/scripts/adb/adb-fix-auth.sh
	@bash $(ROOT)/scripts/adb/adb-fix-auth.sh

adb-fix-keys: ## Régénère clés ADB (après révocation USB sur le téléphone)
	@chmod +x $(ROOT)/scripts/adb/adb-fix-auth.sh
	@bash $(ROOT)/scripts/adb/adb-fix-auth.sh --new-keys

# ---------------------------------------------------------------------------
# ADB Wi‑Fi + batterie réelle (Samsung + Nothing, hors charge USB)
# ---------------------------------------------------------------------------
# Une seule commande (recommandé) :
#   make battery-go
#     → vérifie/attend les 2 physiques en Wi‑Fi
#     → attend débranchement
#     → 30 min de mesure + logs serveur
#     → affiche le rapport
#
# Si Samsung manque :
#   A) Branche-le 2 s en USB pendant make adb-wifi-ensure
#   B) Ou : make adb-wifi-pair  (Débogage sans fil + code)

adb-wifi-doctor: ## Vérifie Samsung + Nothing (ignore le reste / virtuel)
	@chmod +x $(ROOT)/scripts/adb/adb-wifi.sh
	@bash $(ROOT)/scripts/adb/adb-wifi.sh doctor || true

adb-wifi-ensure: ## Attend/connecte Samsung + Nothing en ADB Wi‑Fi
	@chmod +x $(ROOT)/scripts/adb/adb-wifi.sh
	@INCLUDE_NOTHING="$(or $(INCLUDE_NOTHING),1)" bash $(ROOT)/scripts/adb/adb-wifi.sh ensure

adb-both: ## Rapide : reconnecte Samsung (DEV) + Nothing (PROD) en ADB
	@chmod +x $(ROOT)/scripts/adb/adb-wifi.sh
	@INCLUDE_NOTHING=1 MIN_DEVICES=1 bash $(ROOT)/scripts/adb/adb-wifi.sh ensure

adb-devices: ## Alias de make adb-both (liste + reconnect)
	@$(MAKE) adb-both

adb-wifi-pair: ## Associe un téléphone via Débogage sans fil (IP:port + code)
	@chmod +x $(ROOT)/scripts/adb/adb-wifi.sh
	@bash $(ROOT)/scripts/adb/adb-wifi.sh pair

adb-wifi: ## USB → active ADB tcpip + enregistre IPs Wi‑Fi (1+ téléphones)
	@chmod +x $(ROOT)/scripts/adb/adb-wifi.sh
	@if [ -n "$(DEVICES)" ]; then \
	  bash $(ROOT)/scripts/adb/adb-wifi.sh enable $$(echo "$(DEVICES)" | tr ',' ' '); \
	else \
	  bash $(ROOT)/scripts/adb/adb-wifi.sh enable; \
	fi

adb-wifi-connect: ## Connecte ADB en Wi‑Fi (après make adb-wifi)
	@chmod +x $(ROOT)/scripts/adb/adb-wifi.sh
	@bash $(ROOT)/scripts/adb/adb-wifi.sh connect

adb-wifi-status: ## Alias doctor (Samsung + Nothing)
	@chmod +x $(ROOT)/scripts/adb/adb-wifi.sh
	@bash $(ROOT)/scripts/adb/adb-wifi.sh doctor || true

adb-wifi-wait-unplug: ## Attend que Samsung + Nothing soient hors charge USB/AC
	@chmod +x $(ROOT)/scripts/adb/adb-wifi.sh
	@bash $(ROOT)/scripts/adb/adb-wifi.sh wait-unplug

adb-wifi-disconnect: ## Coupe les sessions ADB Wi‑Fi
	@chmod +x $(ROOT)/scripts/adb/adb-wifi.sh
	@bash $(ROOT)/scripts/adb/adb-wifi.sh disconnect

battery-go: ## ALL-IN-ONE : ≥1 Wi‑Fi → test → rapport (USAGE=0 recommandé pour mesure calme)
	@chmod +x $(ROOT)/scripts/adb/adb-wifi.sh $(ROOT)/scripts/battery/battery-session.sh
	@DURATION="$(DURATION)" SAMPLE_SECS="$(SAMPLE_SECS)" MIN_DEVICES="$(or $(MIN_DEVICES),1)" \
	  USAGE="$(or $(USAGE),0)" \
	  bash $(ROOT)/scripts/adb/adb-wifi.sh go

battery-go-calm: ## Test batterie calme : USAGE=0 + écran OFF + mail auto
	@chmod +x $(ROOT)/scripts/adb/adb-wifi.sh $(ROOT)/scripts/battery/battery-session.sh $(ROOT)/scripts/battery/battery-mail-report.mjs
	@echo ""
	@echo "  Lecture calme 30 min — écran OFF, pas de stim ADB, puis email rapport"
	@echo "  Prérequis : make adb-wifi-doctor (Nothing Wi‑Fi OK)"
	@echo ""
	@DURATION="$(or $(DURATION),1800)" SAMPLE_SECS="$(or $(SAMPLE_SECS),15)" MIN_DEVICES="$(or $(MIN_DEVICES),1)" \
	  USAGE=0 bash $(ROOT)/scripts/adb/adb-wifi.sh go
	@cd $(ROOT) && node --env-file=.env scripts/battery/battery-mail-report.mjs || true
	@$(MAKE) battery-report

battery-suite: ## 3 phases (~45 min) : écran OFF / ON / mixte + lecture vérifiée + rapport
	@chmod +x $(ROOT)/scripts/battery/battery-suite.sh $(ROOT)/scripts/battery/battery-mail-report.mjs
	@echo ""
	@echo "  Suite batterie : screen_off → screen_on → mixed (DURATION_PHASE=$(or $(DURATION_PHASE),900)s chacune)"
	@echo "  Débranche le téléphone. Lance une lecture si possible."
	@echo ""
	@DURATION_PHASE="$(or $(DURATION_PHASE),900)" SAMPLE_SECS="$(or $(SAMPLE_SECS),15)" MAIL="$(or $(MAIL),1)" \
	  bash $(ROOT)/scripts/battery/battery-suite.sh

battery-test: ## Session batterie 30 min (Wi‑Fi ADB, débranché) + logs serveur DEV
	@chmod +x $(ROOT)/scripts/battery/battery-session.sh $(ROOT)/scripts/adb/adb-wifi.sh
	@echo ""
	@echo "  Astuce : préfère « make battery-go » (vérifie les 2 appareils avant)."
	@echo "  Durée=$(DURATION)s  sample=$(SAMPLE_SECS)s  sortie=logs/battery-session/"
	@echo ""
	@DURATION="$(DURATION)" SAMPLE_SECS="$(SAMPLE_SECS)" DEVICES="$(DEVICES)" \
	  REQUIRE_UNPLUGGED="$(or $(REQUIRE_UNPLUGGED),1)" USAGE="$(or $(USAGE),1)" \
	  bash $(ROOT)/scripts/battery/battery-session.sh

battery-test-short: ## Idem battery-test mais 3 min (smoke)
	@$(MAKE) battery-test DURATION=180 SAMPLE_SECS=10 DEVICES="$(DEVICES)" REQUIRE_UNPLUGGED="$(or $(REQUIRE_UNPLUGGED),1)"

battery-report: ## Affiche le dernier rapport batterie
	@latest="$(ROOT)/logs/battery-session/latest/REPORT.md"; \
	if [ -f "$$latest" ]; then \
	  echo "==> $$latest"; cat "$$latest"; \
	else \
	  echo "Aucun rapport. Lance : make battery-go"; \
	  ls -1dt $(ROOT)/logs/battery-session/*/REPORT.md 2>/dev/null | head -3 || true; \
	fi

battery-report-mail: ## Email le dernier rapport batterie → BATTERY_REPORT_TO / SEED_EMAIL (+ zip)
	@chmod +x $(ROOT)/scripts/battery/battery-mail-report.mjs
	@cd $(ROOT) && node --env-file=.env scripts/battery/battery-mail-report.mjs

android-prod: ## APK → API prod (PUBLIC_API_URL / DEPLOY_URL / ANDROID_API_BASE_URL) + ADB + publish
	@chmod +x $(ROOT)/scripts/android/kotlin-android-install.sh $(ROOT)/scripts/android/android-publish-apk.sh
	@API_URL="$$( \
	  if [ -n "$(API_BASE_URL)" ]; then echo "$(API_BASE_URL)"; \
	  else \
	    v=$$(grep -E '^PUBLIC_API_URL=' $(ROOT)/.env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d ' '); \
	    if [ -n "$$v" ]; then echo "$$v"; \
	    else \
	      v=$$(grep -E '^ANDROID_API_BASE_URL=' $(ROOT)/.env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d ' '); \
	      if [ -n "$$v" ]; then echo "$$v"; \
	      else \
	        v=$$(grep -E '^DEPLOY_URL=' $(ROOT)/.env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d ' '); \
	        case "$$v" in *127.0.0.1*|*localhost*|"" ) echo "" ;; *) echo "$$v" ;; esac; \
	      fi; \
	    fi; \
	  fi)"; \
	 if [ -z "$$API_URL" ]; then echo "❌ Définis PUBLIC_API_URL ou DEPLOY_URL dans .env" >&2; exit 1; fi; \
	 echo "==> android-prod API=$$API_URL"; \
	 DEVICE="$(DEVICE)" API_BASE_URL="$$API_URL" bash $(ROOT)/scripts/android/kotlin-android-install.sh install; \
	 API_BASE_URL="$$API_URL" bash $(ROOT)/scripts/android/android-publish-apk.sh

android-capacitor: ## Legacy : APK Capacitor (WebView) + API locale
	@chmod +x $(ROOT)/scripts/android/android-install.sh $(ROOT)/scripts/dev/ensure-api.sh
	@bash $(ROOT)/scripts/dev/ensure-api.sh
	@DEVICE="$(DEVICE)" VITE_API_ORIGIN="$(or $(VITE_API_ORIGIN),http://127.0.0.1:8787)" bash $(ROOT)/scripts/android/android-install.sh install

android-capacitor-prod: ## Legacy Capacitor → API PUBLIC_API_URL / DEPLOY_URL
	@chmod +x $(ROOT)/scripts/android/android-install.sh
	@API_URL="$$(grep -E '^(PUBLIC_API_URL|DEPLOY_URL)=' $(ROOT)/.env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d ' ')"; \
	 if [ -z "$$API_URL" ]; then echo "❌ PUBLIC_API_URL / DEPLOY_URL manquant" >&2; exit 1; fi; \
	 DEVICE="$(DEVICE)" VITE_API_ORIGIN="$$API_URL" bash $(ROOT)/scripts/android/android-install.sh install

test-register-adb: ## Recrée compte + email validation + ouvre le lien sur Android
	@cd $(ROOT) && \
	  DEVICE="$(DEVICE)" \
	  TEST_EMAIL="$(or $(TEST_EMAIL),$(SEED_EMAIL))" \
	  TEST_PASSWORD="$(TEST_PASSWORD)" \
	  node scripts/test/test-register-verify-adb.mjs

update-apps: ## Rappel : comment MAJ web / mobile / desktop
	@echo ""
	@echo "  Mises à jour (sans store, sans pubs)"
	@echo "  -----------------------------------"
	@echo "  Web + PWA : push prod → CI GHCR → Portainer/Watchtower"
	@echo "  APK Kotlin : make android / make android-prod"
	@echo "  Version    : make bump-patch|minor|major  (affiche d+/p+ sous Déconnexion)"
	@echo "  Docs : docs/DNS-ET-INSTALL.md  DEPLOY.md"
	@echo ""

# ---------------------------------------------------------------------------
# Statut & logs
# ---------------------------------------------------------------------------

status: ## Statut coloré API / Vite / process locaux / Docker / ADB
	@echo ""
	@printf "$(C_BOLD)📊 Statut PLM$(C_RESET)\n"
	@echo "================="
	@echo ""
	@printf "  "; \
	if curl -fsS --max-time 2 http://127.0.0.1:8787/api/health >/tmp/ytm-health.json 2>/dev/null; then \
	  VER=$$(python3 -c "import json;d=json.load(open('/tmp/ytm-health.json'));print(d.get('appVersion') or d.get('version','?'),d.get('ref',''))" 2>/dev/null || echo ok); \
	  printf "\033[1;32m✅ UP\033[0m   %-22s \033[0;36m8787\033[0m  %s\n" "api" "$$VER"; \
	else \
	  printf "\033[1;31m❌ DOWN\033[0m %-22s \033[0;90m:8787\033[0m\n" "api"; \
	fi
	@printf "  "; \
	if curl -fsS --max-time 2 -o /dev/null http://127.0.0.1:5173/ 2>/dev/null; then \
	  printf "\033[1;32m✅ UP\033[0m   %-22s \033[0;36m5173\033[0m  vite\n" "client"; \
	else \
	  printf "\033[1;90m⚪ DOWN\033[0m %-22s \033[0;90m:5173 (make up)\033[0m\n" "client"; \
	fi
	@echo ""
	@if [ -f "$(ROOT)/data/ytmusic.db" ]; then \
	  printf "  \033[1;32m✅ DB\033[0m    %-22s %s\n" "sqlite" "$$(du -h "$(ROOT)/data/ytmusic.db" | awk '{print $$1}')"; \
	else \
	  printf "  \033[1;33m⚠ DB\033[0m    %-22s \033[0;90mabsente\033[0m\n" "sqlite"; \
	fi
	@MODE=$$(cat "$(ROOT)/.ytmusic-stack-mode" 2>/dev/null || true); \
	if [ -n "$$MODE" ]; then printf "  \033[0;90m📌 dernier mode : %s\033[0m\n" "$$MODE"; fi
	@echo ""
	@echo "🖥  Process locaux (make up / up-full) :"
	@echo ""
	@found_local=0; \
	if [ -f "$(ROOT)/logs/ytmusic-server.pid" ]; then \
	  spid=$$(cat "$(ROOT)/logs/ytmusic-server.pid" 2>/dev/null); \
	  if [ -n "$$spid" ] && kill -0 "$$spid" 2>/dev/null; then \
	    found_local=1; \
	    printf "  \033[1;32m✅ UP\033[0m   %-22s pid %s  api/tsx\n" "server" "$$spid"; \
	  fi; \
	fi; \
	if [ -f "$(ROOT)/logs/ytmusic-web.pid" ]; then \
	  wpid=$$(cat "$(ROOT)/logs/ytmusic-web.pid" 2>/dev/null); \
	  if [ -n "$$wpid" ] && kill -0 "$$wpid" 2>/dev/null; then \
	    found_local=1; \
	    printf "  \033[1;32m✅ UP\033[0m   %-22s pid %s  vite\n" "web" "$$wpid"; \
	  fi; \
	fi; \
	if [ "$$found_local" = "0" ]; then \
	  if pgrep -af 'tsx api/src/index.ts|api/src/index.ts' >/dev/null 2>&1; then \
	    found_local=1; \
	    printf "  \033[1;32m✅ UP\033[0m   %-22s (tsx détecté)\n" "server"; \
	  fi; \
	  if pgrep -af '[v]ite' >/dev/null 2>&1; then \
	    found_local=1; \
	    printf "  \033[1;32m✅ UP\033[0m   %-22s (vite détecté)\n" "web"; \
	  fi; \
	fi; \
	if [ "$$found_local" = "0" ]; then \
	  printf "  \033[0;90m(aucun process local — make up / make up-full)\033[0m\n"; \
	fi
	@echo ""
	@echo "🐳 Conteneurs docker (ytmusic* / mailhog) :"
	@echo ""
	@found=0; \
	for c in $$(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -E 'ytmusic|mailhog' || true); do \
	  found=1; \
	  if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$$c"; then \
	    ports=$$(docker ps --filter "name=^$$c$$" --format '{{.Ports}}' 2>/dev/null); \
	    st=$$(docker ps --filter "name=^$$c$$" --format '{{.Status}}' 2>/dev/null); \
	    printf "  \033[1;32m✅ UP\033[0m   %-28s %s\n" "$$c" "$$ports"; \
	    printf "         \033[0;90m%s\033[0m\n" "$$st"; \
	  else \
	    st=$$(docker ps -a --filter "name=^$$c$$" --format '{{.Status}}' 2>/dev/null); \
	    printf "  \033[1;31m❌ DOWN\033[0m %-28s \033[0;90m%s\033[0m\n" "$$c" "$$st"; \
	  fi; \
	done; \
	if [ "$$found" = "0" ]; then \
	  printf "  \033[0;90m(aucun — normal si stack Node local ; optionnel : make docker-dev)\033[0m\n"; \
	fi
	@echo ""
	@echo "📱 ADB (Samsung=DEV · Nothing=PROD) — make adb-both :"
	@echo ""
	@ADB_OUT=$$(adb devices -l 2>/dev/null || true); \
	print_dev() { \
	  local role="$$1" label="$$2" serial="$$3" ip="$$4"; \
	  local line; \
	  line=$$(printf '%s\n' "$$ADB_OUT" | awk -v s="$$serial" -v ip="$$ip" '$$2=="device" && (index($$0,s)||index($$0,ip)){print; exit}'); \
	  if [ -n "$$line" ]; then \
	    printf "  \033[1;32m✅ %s\033[0m %-10s %s\n" "$$role" "$$label" "$$line"; \
	  else \
	    printf "  \033[1;31m❌ %s\033[0m %-10s manquant  → make adb-both  (%s / %s)\n" "$$role" "$$label" "$$serial" "$$ip"; \
	  fi; \
	}; \
	print_dev "DEV " "Samsung" "R5CT7263YJL" "192.168.1.184:5555"; \
	print_dev "PROD" "Nothing" "00145153K001434" "192.168.1.44:5555"; \
	printf '%s\n' "$$ADB_OUT" | awk 'NR>1 && NF && $$2!="device"{ \
	  if($$2=="unauthorized") printf "  \033[1;33m⚠ unauthorized\033[0m %s  → accepte la popup USB\n", $$1; \
	  else if($$2=="offline") printf "  \033[1;31m❌ offline\033[0m %s\n", $$1; \
	  else printf "  \033[0;90m· %s\033[0m\n", $$0; \
	}'
	@echo ""
	@LAN=$$(hostname -I 2>/dev/null | awk '{print $$1}'); \
	if [ -n "$$LAN" ]; then echo "  LAN → http://$$LAN:5173  ·  API http://$$LAN:8787"; fi
	@echo ""

status-watch: ## Rafraîchit make status en boucle (INTERVAL=4)
	@chmod +x $(ROOT)/scripts/dev/status-watch.sh 2>/dev/null || true
	@INTERVAL="$(or $(INTERVAL),4)" CLEAR="$(or $(CLEAR),1)" bash $(ROOT)/scripts/dev/status-watch.sh

link-home-stream: ## Relais streams prod → API maison (IP résidentielle YouTube)
	@chmod +x $(ROOT)/scripts/deploy/link-home-stream.sh
	@bash $(ROOT)/scripts/deploy/link-home-stream.sh start

link-home-stream-status: ## Statut tunnel STREAM_UPSTREAM
	@chmod +x $(ROOT)/scripts/deploy/link-home-stream.sh
	@bash $(ROOT)/scripts/deploy/link-home-stream.sh status

link-home-stream-stop: ## Stoppe le tunnel maison
	@chmod +x $(ROOT)/scripts/deploy/link-home-stream.sh
	@bash $(ROOT)/scripts/deploy/link-home-stream.sh stop

logs: ## Logs colorés + suivi temps réel (Docker ou local) — Ctrl+C
	@chmod +x $(ROOT)/scripts/ops/logs.sh $(ROOT)/scripts/ops/color-logs.sh
	@LOGS_SINCE="$(or $(LOGS_SINCE),24h)" LOGS_TAIL="$(or $(LOGS_TAIL),500)" \
	  bash $(ROOT)/scripts/ops/logs.sh follow

logs-tail: ## Dernières lignes puis quitte (LOGS_TAIL=200)
	@chmod +x $(ROOT)/scripts/ops/logs.sh $(ROOT)/scripts/ops/color-logs.sh
	@LOGS_TAIL="$(or $(LOGS_TAIL),200)" bash $(ROOT)/scripts/ops/logs.sh tail

logs-watch: ## Logs avec reconnexion auto (Docker) — Ctrl+C
	@chmod +x $(ROOT)/scripts/ops/logs.sh $(ROOT)/scripts/ops/color-logs.sh
	@LOGS_SINCE="$(or $(LOGS_SINCE),24h)" LOGS_TAIL="$(or $(LOGS_TAIL),500)" \
	  bash $(ROOT)/scripts/ops/logs.sh watch

logs-history: ## Archives + historique puis suivi — Ctrl+C
	@chmod +x $(ROOT)/scripts/ops/logs.sh $(ROOT)/scripts/ops/color-logs.sh
	@LOGS_SINCE="$(or $(LOGS_SINCE),168h)" LOGS_TAIL="$(or $(LOGS_TAIL),2000)" \
	  bash $(ROOT)/scripts/ops/logs.sh history

logs-archive: ## Rotate les logs locaux vers logs/archive/
	@chmod +x $(ROOT)/scripts/ops/archive-logs.sh
	@bash $(ROOT)/scripts/ops/archive-logs.sh

# ---------------------------------------------------------------------------
# Base de données
# ---------------------------------------------------------------------------

db-status: ## Stats SQLite (users, likes, refresh, orphans)
	@chmod +x $(ROOT)/scripts/dev/db-ops.sh
	@bash $(ROOT)/scripts/dev/db-ops.sh status

db-backup: ## Backup data/ytmusic.db → data/backups/
	@chmod +x $(ROOT)/scripts/dev/db-ops.sh
	@bash $(ROOT)/scripts/dev/db-ops.sh backup

ports: ## Affiche qui écoute 5173 / 8787
	@echo "Ports PLM :"
	@ss -tlnp 2>/dev/null | grep -E ':5173|:8787' || netstat -tlnp 2>/dev/null | grep -E '5173|8787' || echo "  (rien)"
	@echo ""
	@for p in 5173 8787; do \
	  pids=$$(lsof -tiTCP:$$p -sTCP:LISTEN 2>/dev/null || true); \
	  if [ -n "$$pids" ]; then \
	    echo "  :$$p → $$pids"; \
	    for pid in $$pids; do \
	      printf "    "; tr '\0' ' ' < /proc/$$pid/cmdline 2>/dev/null | cut -c1-100; echo; \
	    done; \
	  fi; \
	done

kill-dev: ## Alias de down — tue 5173 et 8787
	@$(MAKE) --no-print-directory down

push-dev: ## Push la branche courante vers origin
	cd $(ROOT) && git push -u origin HEAD

push-prod: ## Merge dev → prod localement puis push (ATTENTION prod)
	@echo "Merge dev → prod puis push…"
	cd $(ROOT) && git fetch origin && \
	  git checkout prod && git pull origin prod && \
	  git merge origin/dev -m "merge: promu dev → prod" && \
	  git push origin prod && \
	  git checkout -

deploy-hint: ## Guide déploiement Portainer / NPM / mobile
	@echo ""
	@echo "  Déploiement perso (détail : DEPLOY.md)"
	@echo "  --------------------------------------"
	@echo "  DNS  (DEPLOY_URL / PUBLIC_API_URL) → IP VPS"
	@echo ""
	@echo "  WEB  Admin localhost → Mise en prod → Web (git → image)"
	@echo "       Redeploy CE (pas de webhook Pro) :"
	@echo "         A) stack watchtower = deploy/watchtower-compose.yml"
	@echo "         B) PORTAINER_URL + PORTAINER_API_KEY (Access Token)"
	@echo "         C) DEPLOY_SSH=user@vps"
	@echo ""
	@echo "  APK  Admin → APK → VPS   ou   make android-upload-apk"
	@echo ""
	@echo "  Docs : DEPLOY.md"
	@echo ""

version: ## Affiche la version courante (fichier VERSION)
	@v=$$(tr -d '[:space:]' <$(ROOT)/VERSION); \
	  echo "VERSION $$v  →  d+$$v (local/dev) · p+$$v (prod)"

bump-patch: ## Correctif : X.Y.Z → X.Y.(Z+1)
	@chmod +x $(ROOT)/scripts/deploy/bump-version.sh
	@bash $(ROOT)/scripts/deploy/bump-version.sh patch

bump-minor: ## Fonctionnalité : X.Y.Z → X.(Y+1).0
	@chmod +x $(ROOT)/scripts/deploy/bump-version.sh
	@bash $(ROOT)/scripts/deploy/bump-version.sh minor

bump-major: ## Breaking : X.Y.Z → (X+1).0.0
	@chmod +x $(ROOT)/scripts/deploy/bump-version.sh
	@bash $(ROOT)/scripts/deploy/bump-version.sh major
