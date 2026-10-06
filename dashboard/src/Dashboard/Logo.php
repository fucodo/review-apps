<?php

declare(strict_types=1);

namespace App\Dashboard;

use Psr\Log\LoggerInterface;
use Symfony\Component\DependencyInjection\Attribute\Autowire;

/**
 * Optional logo in the dashboard header, configured via DASHBOARD_LOGO / DASHBOARD_LOGO_LINK.
 * It is also used as favicon and app icon.
 *
 * DASHBOARD_LOGO accepts
 *  - an http(s) URL,
 *  - a data URI ("data:image/png;base64,…", must be quoted in .env because of the ";"),
 *  - plain base64 of an image file (type is detected from the content).
 */
final class Logo
{
    /** @var array{src: string, type: ?string, data: ?string}|null */
    private ?array $resolved = null;
    private bool $isResolved = false;

    public function __construct(
        #[Autowire(env: 'DASHBOARD_LOGO')] private readonly string $logo,
        #[Autowire(env: 'DASHBOARD_LOGO_LINK')] private readonly string $link,
        private readonly LoggerInterface $logger,
    ) {
    }

    /** Value for <img src>, null if no (valid) logo is configured. */
    public function src(): ?string
    {
        return $this->resolve()['src'] ?? null;
    }

    /** Target of the logo link, null if none (or no valid http(s) URL) is configured. */
    public function link(): ?string
    {
        $link = trim($this->link);

        return self::isHttpUrl($link) ? $link : null;
    }

    /** MIME type of the logo; for URLs guessed from the file extension, null if unknown. */
    public function type(): ?string
    {
        return $this->resolve()['type'] ?? null;
    }

    /** Short hash of the configured logo, used to bust browser caches when it changes. */
    public function version(): string
    {
        return substr(hash('xxh128', $this->logo), 0, 12);
    }

    /** Whether the image data is configured inline (data URI / base64) and can be served as icon by the dashboard. */
    public function isInline(): bool
    {
        return null !== ($this->resolve()['data'] ?? null);
    }

    /**
     * Image data for use as icon; SVGs are centered on the smallest enclosing square.
     *
     * @return array{type: string, data: string}|null null if no inline logo is configured
     */
    public function icon(): ?array
    {
        $logo = $this->resolve();
        if (null === $logo || null === $logo['data'] || null === $logo['type']) {
            return null;
        }

        return [
            'type' => $logo['type'],
            'data' => 'image/svg+xml' === $logo['type'] ? SquareSvg::square($logo['data']) : $logo['data'],
        ];
    }

    /**
     * @return array{src: string, type: ?string, data: ?string}|null
     */
    private function resolve(): ?array
    {
        if (!$this->isResolved) {
            $this->isResolved = true;
            $this->resolved = $this->parse(trim($this->logo));
        }

        return $this->resolved;
    }

    /**
     * @return array{src: string, type: ?string, data: ?string}|null
     */
    private function parse(string $logo): ?array
    {
        if ('' === $logo) {
            return null;
        }

        if (self::isHttpUrl($logo)) {
            $type = match (strtolower(pathinfo((string) parse_url($logo, \PHP_URL_PATH), \PATHINFO_EXTENSION))) {
                'svg' => 'image/svg+xml',
                'png' => 'image/png',
                'jpg', 'jpeg' => 'image/jpeg',
                'gif' => 'image/gif',
                'webp' => 'image/webp',
                'ico' => 'image/x-icon',
                default => null,
            };

            return ['src' => $logo, 'type' => $type, 'data' => null];
        }

        if (preg_match('#^data:(image/[a-z0-9.+-]+)((?:;[a-z0-9=.+-]+)*),(.*)$#is', $logo, $m)) {
            $data = str_contains(strtolower($m[2]), ';base64') ? base64_decode($m[3], true) : rawurldecode($m[3]);
            if (false !== $data) {
                return ['src' => $logo, 'type' => self::normalizeType(strtolower($m[1])), 'data' => $data];
            }
        } else {
            $data = base64_decode(preg_replace('/\s+/', '', $logo), true);
            $type = false !== $data ? (new \finfo(\FILEINFO_MIME_TYPE))->buffer($data) : false;
            if (\is_string($type) && str_starts_with($type, 'image/')) {
                $type = self::normalizeType($type);

                return ['src' => 'data:'.$type.';base64,'.base64_encode($data), 'type' => $type, 'data' => $data];
            }
        }

        $this->logger->warning('DASHBOARD_LOGO is neither an http(s) URL, an image data URI nor base64 encoded image data, ignoring it.');

        return null;
    }

    private static function normalizeType(string $type): string
    {
        // Older libmagic versions report SVGs as image/svg
        return 'image/svg' === $type ? 'image/svg+xml' : $type;
    }

    private static function isHttpUrl(string $url): bool
    {
        return (bool) preg_match('#^https?://#i', $url) && false !== filter_var($url, \FILTER_VALIDATE_URL);
    }
}
