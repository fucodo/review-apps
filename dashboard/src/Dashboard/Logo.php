<?php

declare(strict_types=1);

namespace App\Dashboard;

use Psr\Log\LoggerInterface;
use Symfony\Component\DependencyInjection\Attribute\Autowire;

/**
 * Optional logo in the dashboard header, configured via DASHBOARD_LOGO / DASHBOARD_LOGO_LINK.
 *
 * DASHBOARD_LOGO accepts
 *  - an http(s) URL,
 *  - a data URI ("data:image/png;base64,…", must be quoted in .env because of the ";"),
 *  - plain base64 of an image file (type is detected from the content).
 */
final class Logo
{
    private ?string $src = null;
    private bool $resolved = false;

    public function __construct(
        #[Autowire(env: 'DASHBOARD_LOGO')] private readonly string $logo,
        #[Autowire(env: 'DASHBOARD_LOGO_LINK')] private readonly string $link,
        private readonly LoggerInterface $logger,
    ) {
    }

    /** Value for <img src>, null if no (valid) logo is configured. */
    public function src(): ?string
    {
        if (!$this->resolved) {
            $this->resolved = true;
            $this->src = $this->resolve(trim($this->logo));
        }

        return $this->src;
    }

    /** Target of the logo link, null if none (or no valid http(s) URL) is configured. */
    public function link(): ?string
    {
        $link = trim($this->link);

        return self::isHttpUrl($link) ? $link : null;
    }

    private function resolve(string $logo): ?string
    {
        if ('' === $logo) {
            return null;
        }
        if (self::isHttpUrl($logo)) {
            return $logo;
        }
        if (preg_match('#^data:image/[a-z0-9.+-]+(;[a-z0-9=.+-]+)*,#i', $logo)) {
            return $logo;
        }

        $binary = base64_decode(preg_replace('/\s+/', '', $logo), true);
        $mime = false !== $binary ? (new \finfo(\FILEINFO_MIME_TYPE))->buffer($binary) : false;
        if (\is_string($mime) && str_starts_with($mime, 'image/')) {
            return 'data:'.$mime.';base64,'.base64_encode($binary);
        }

        $this->logger->warning('DASHBOARD_LOGO is neither an http(s) URL, an image data URI nor base64 encoded image data, ignoring it.');

        return null;
    }

    private static function isHttpUrl(string $url): bool
    {
        return (bool) preg_match('#^https?://#i', $url) && false !== filter_var($url, \FILTER_VALIDATE_URL);
    }
}
