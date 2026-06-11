FROM php:8.3-apache

RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && apt-get install -y --no-install-recommends curl libsqlite3-dev libzip-dev unzip \
    && docker-php-ext-install pdo_sqlite zip \
    && apt-mark manual curl libsqlite3-0 libzip5 unzip \
    && apt-get purge -y --auto-remove libsqlite3-dev libzip-dev linux-libc-dev zlib1g-dev \
    && a2enmod rewrite headers \
    && rm -rf /var/lib/apt/lists/*

ENV APP_CONFIG_DIR=/config \
    APP_PORT=3443 \
    DRIVE_FILES_DIR=/config/drive-files \
    DRIVE_UPLOAD_MAX_MB=250 \
    TRUST_PROXY=false \
    SECURE_COOKIES=false \
    SKIP_CONFIG_CHOWN=false \
    PUID= \
    PGID= \
    DIVAULT_CHOWN_MEDIA=false \
    DIVAULT_LOG_LEVEL=info

COPY public/ /var/www/html/
COPY src/ /var/www/src/
COPY docker-entrypoint.sh /usr/local/bin/divault-entrypoint

RUN sed -i 's/Listen 80/Listen 3443/' /etc/apache2/ports.conf \
    && sed -i 's/:80/:3443/g' /etc/apache2/sites-available/000-default.conf \
    && echo 'ServerName localhost' > /etc/apache2/conf-available/divault-servername.conf \
    && { \
        echo 'SetEnvIf Request_URI "^/api/integrations/onlyoffice/(download|callback)/" divault_sensitive_path'; \
        echo 'LogFormat "%h %l %u %t \"%m /api/integrations/onlyoffice/[redacted] %H\" %>s %O \"%{Referer}i\" \"%{User-Agent}i\"" divault_redacted'; \
    } > /etc/apache2/conf-available/divault-logs.conf \
    && a2enconf divault-servername \
    && a2enconf divault-logs \
    && sed -i 's#^[[:space:]]*CustomLog ${APACHE_LOG_DIR}/access.log combined#\tCustomLog /proc/self/fd/1 combined env=!divault_sensitive_path\n\tCustomLog /proc/self/fd/1 divault_redacted env=divault_sensitive_path#' /etc/apache2/sites-available/000-default.conf \
    && { \
        echo 'upload_max_filesize=2G'; \
        echo 'post_max_size=2G'; \
        echo 'max_execution_time=600'; \
        echo 'max_input_time=600'; \
        echo 'memory_limit=512M'; \
    } > /usr/local/etc/php/conf.d/divault-uploads.ini \
    && { \
        echo 'opcache.enable=1'; \
        echo 'opcache.enable_cli=0'; \
        echo 'opcache.validate_timestamps=0'; \
        echo 'opcache.memory_consumption=128'; \
        echo 'opcache.max_accelerated_files=10000'; \
    } > /usr/local/etc/php/conf.d/divault-opcache.ini \
    && chmod +x /usr/local/bin/divault-entrypoint \
    && chown -R www-data:www-data /var/www/html /var/www/src

VOLUME ["/config"]
EXPOSE 3443
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://localhost:3443/api/health || exit 1
# trivy:ignore:AVD-DS-0002
# Root entrypoint is required for PUID/PGID remapping and volume ownership repair;
# Apache is configured to serve requests through the www-data worker user.
ENTRYPOINT ["divault-entrypoint"]
CMD ["apache2-foreground"]
