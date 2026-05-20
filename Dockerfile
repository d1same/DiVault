FROM php:8.3-apache

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl libsqlite3-dev libzip-dev unzip \
    && docker-php-ext-install pdo_sqlite zip \
    && a2enmod rewrite headers \
    && rm -rf /var/lib/apt/lists/*

ENV APP_CONFIG_DIR=/config \
    APP_PORT=3443 \
    DRIVE_FILES_DIR=/config/drive-files \
    DRIVE_UPLOAD_MAX_MB=250 \
    TRUST_PROXY=false \
    SECURE_COOKIES=false \
    SKIP_CONFIG_CHOWN=false

COPY public/ /var/www/html/
COPY src/ /var/www/src/
COPY docker-entrypoint.sh /usr/local/bin/divault-entrypoint

RUN sed -i 's/Listen 80/Listen 3443/' /etc/apache2/ports.conf \
    && sed -i 's/:80/:3443/g' /etc/apache2/sites-available/000-default.conf \
    && { \
        echo 'upload_max_filesize=2G'; \
        echo 'post_max_size=2G'; \
        echo 'max_execution_time=600'; \
        echo 'max_input_time=600'; \
        echo 'memory_limit=512M'; \
    } > /usr/local/etc/php/conf.d/divault-uploads.ini \
    && chmod +x /usr/local/bin/divault-entrypoint \
    && chown -R www-data:www-data /var/www/html /var/www/src

VOLUME ["/config"]
EXPOSE 3443
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://localhost:3443/api/health || exit 1
ENTRYPOINT ["divault-entrypoint"]
CMD ["apache2-foreground"]
