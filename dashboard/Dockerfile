FROM composer:2 AS vendor
WORKDIR /app
COPY composer.json composer.lock symfony.lock ./
RUN composer install --no-dev --no-scripts --no-autoloader --no-interaction --prefer-dist --ignore-platform-reqs
COPY . .
RUN composer dump-autoload --no-dev --classmap-authoritative

FROM php:8.4-cli-alpine
RUN docker-php-ext-enable opcache \
 && printf 'opcache.enable_cli=1\nopcache.validate_timestamps=0\n' > /usr/local/etc/php/conf.d/zz-opcache.ini
ENV APP_ENV=prod APP_DEBUG=0
WORKDIR /srv
COPY --from=vendor --chown=www-data:www-data /app /srv
USER www-data
RUN php bin/console cache:warmup
EXPOSE 8080
# Unknown paths fall back to public/index.php (Symfony front controller), existing files are served directly
# EGPCS: expose real environment variables (e.g. DOCKER_API) to Symfony, the CLI server omits them by default
CMD ["php", "-d", "variables_order=EGPCS", "-S", "0.0.0.0:8080", "-t", "public"]
