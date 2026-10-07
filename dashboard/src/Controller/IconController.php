<?php

declare(strict_types=1);

namespace App\Controller;

use App\Dashboard\Logo;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\RedirectResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;
use Symfony\Component\Routing\Generator\UrlGeneratorInterface;

/**
 * Serves the dashboard logo (DASHBOARD_LOGO) as favicon and app icon.
 */
final class IconController
{
    public function __construct(
        private readonly Logo $logo,
        private readonly UrlGeneratorInterface $urls,
    ) {
    }

    #[Route('/icon', name: 'icon', methods: ['GET', 'HEAD'])]
    #[Route('/favicon.ico', name: 'favicon', methods: ['GET', 'HEAD'])]
    public function icon(Request $request): Response
    {
        $icon = $this->logo->icon();
        if (null === $icon) {
            // Logos configured as URL are loaded by the browser directly
            $src = $this->logo->src();

            return null !== $src ? new RedirectResponse($src) : new Response('', Response::HTTP_NOT_FOUND);
        }

        $response = new Response($icon['data'], Response::HTTP_OK, [
            'Content-Type' => $icon['type'],
            'X-Content-Type-Options' => 'nosniff',
            // Opened directly, an SVG is a document: never run scripts or load anything from it
            'Content-Security-Policy' => "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
        ]);
        $response->setEtag(hash('xxh128', $icon['data']));
        $response->setPrivate();
        $response->setMaxAge(86400);
        $response->isNotModified($request);

        return $response;
    }

    #[Route('/manifest.webmanifest', name: 'manifest', methods: ['GET', 'HEAD'])]
    public function manifest(): Response
    {
        $manifest = [
            'name' => 'Review environments',
            'short_name' => 'Reviews',
            'start_url' => $this->urls->generate('dashboard'),
            'display' => 'browser',
            'icons' => [],
        ];

        if (null !== $this->logo->src()) {
            $type = $this->logo->type();
            $icon = [
                'src' => $this->logo->isInline() ? $this->urls->generate('icon', ['v' => $this->logo->version()]) : $this->logo->src(),
                'purpose' => 'any',
            ];
            if (null !== $type) {
                $icon['type'] = $type;
            }
            if ('image/svg+xml' === $type) {
                $icon['sizes'] = 'any';
            } elseif ($this->logo->isInline() && false !== ($size = @getimagesizefromstring($this->logo->icon()['data'] ?? ''))) {
                $icon['sizes'] = $size[0].'x'.$size[1];
            }
            $manifest['icons'][] = $icon;
        }

        $response = new JsonResponse($manifest);
        $response->headers->set('Content-Type', 'application/manifest+json');
        $response->setEncodingOptions(\JSON_UNESCAPED_SLASHES | \JSON_UNESCAPED_UNICODE);

        return $response;
    }
}
