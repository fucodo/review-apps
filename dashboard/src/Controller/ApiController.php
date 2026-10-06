<?php

declare(strict_types=1);

namespace App\Controller;

use App\Docker\ReviewEnvironmentProvider;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;

final class ApiController
{
    public function __construct(private readonly ReviewEnvironmentProvider $provider)
    {
    }

    #[Route('/api/environments', name: 'api_environments', methods: ['GET', 'HEAD'])]
    public function environments(Request $request): Response
    {
        $data = $this->provider->fetch();

        // Optional filter on the GitLab project path, e.g. ?project=group/app
        $project = $request->query->getString('project');
        if ('' !== $project) {
            foreach (['branches', 'environments'] as $list) {
                $data[$list] = array_values(array_filter(
                    $data[$list],
                    static fn (array $env): bool => $env['project'] === $project,
                ));
            }
        }

        $response = new JsonResponse($data);
        $response->setEncodingOptions(\JSON_PRETTY_PRINT | \JSON_UNESCAPED_SLASHES | \JSON_UNESCAPED_UNICODE);

        // Polling clients revalidate via ETag and get a body-less 304 while nothing changed
        $response->setEtag(hash('xxh128', $response->getContent()));
        $response->setPrivate();
        $response->headers->addCacheControlDirective('no-cache');
        $response->isNotModified($request);

        return $response;
    }
}
