# PLM — image de build APK Android (JDK 17 + Android SDK)
# Usage (via Makefile) :
#   make android-docker-image
#   API_BASE_URL=https://ytmusic.delhomme.ovh make android-docker-apk
#
# Contexte de build = ce dossier (léger) ; le code est monté au run.

FROM eclipse-temurin:17-jdk-jammy

ENV DEBIAN_FRONTEND=noninteractive \
    ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    PATH="/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:${PATH}"

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl unzip git ca-certificates python3 rsync \
    && rm -rf /var/lib/apt/lists/*

# cmdline-tools (sdkmanager)
ARG CMDLINE_TOOLS_URL=https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
RUN mkdir -p "${ANDROID_HOME}/cmdline-tools" \
 && curl -fsSL "${CMDLINE_TOOLS_URL}" -o /tmp/cmdline-tools.zip \
 && unzip -q /tmp/cmdline-tools.zip -d /tmp/cmdline \
 && mv /tmp/cmdline/cmdline-tools "${ANDROID_HOME}/cmdline-tools/latest" \
 && rm -rf /tmp/cmdline-tools.zip /tmp/cmdline

# Platform 35 + build-tools (aligné compileSdk / AGP 8.7)
RUN yes | sdkmanager --licenses >/dev/null \
 && sdkmanager --install \
      "platforms;android-35" \
      "build-tools;35.0.0" \
      "platform-tools" \
 && rm -rf "${ANDROID_HOME}/.temp" "${ANDROID_HOME}/.cache" || true

WORKDIR /src/mobile-android
COPY entrypoint.sh /usr/local/bin/plm-apk-entrypoint
RUN chmod +x /usr/local/bin/plm-apk-entrypoint

ENTRYPOINT ["/usr/local/bin/plm-apk-entrypoint"]
