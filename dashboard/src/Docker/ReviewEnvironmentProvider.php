<?php

declare(strict_types=1);

namespace App\Docker;

use Psr\Log\LoggerInterface;
use Symfony\Component\DependencyInjection\Attribute\Target;
use Symfony\Contracts\Cache\CacheInterface;
use Symfony\Contracts\Cache\ItemInterface;
use Symfony\Contracts\HttpClient\Exception\ExceptionInterface;
use Symfony\Contracts\HttpClient\HttpClientInterface;

/**
 * Reads review containers from the read-only Docker API (docker-socket-proxy, CONTAINERS=1)
 * and groups them per project and merge request.
 *
 * Results are cached for a few seconds, so any number of open dashboards cause at most one
 * Docker API call per TTL. If the API is unreachable, the last successful result is served
 * with ok=false, so clients keep showing data instead of an empty list.
 */
final class ReviewEnvironmentProvider
{
    private const string CACHE_KEY = 'environments';
    private const string LAST_GOOD_KEY = 'environments.last_good';
    private const int TTL = 5;

    public function __construct(
        #[Target('docker.client')] private readonly HttpClientInterface $docker,
        #[Target('review.cache')] private readonly CacheInterface $cache,
        private readonly LoggerInterface $logger,
    ) {
    }

    /**
     * @return array{ok: bool, error: ?string, fetched_at: ?string, environments: list<array<string, mixed>>}
     */
    public function fetch(): array
    {
        return $this->cache->get(self::CACHE_KEY, function (ItemInterface $item): array {
            $item->expiresAfter(self::TTL);

            try {
                $result = [
                    'ok' => true,
                    'error' => null,
                    'fetched_at' => (new \DateTimeImmutable())->format(\DATE_ATOM),
                    'environments' => $this->group($this->listContainers()),
                ];
            } catch (ExceptionInterface|\JsonException $e) {
                $this->logger->error('Docker API request failed: {message}', ['message' => $e->getMessage(), 'exception' => $e]);
                $last = $this->cache->get(self::LAST_GOOD_KEY, static fn (): ?array => null);

                return [
                    'ok' => false,
                    'error' => 'Docker-API nicht erreichbar',
                    'fetched_at' => $last['fetched_at'] ?? null,
                    'environments' => $last['environments'] ?? [],
                ];
            }

            // beta=INF forces the value to be recomputed and stored
            $this->cache->get(self::LAST_GOOD_KEY, static fn (): array => $result, \INF);

            return $result;
        });
    }

    /**
     * @return list<array<string, mixed>>
     */
    private function listContainers(): array
    {
        // Filter on the Docker side, so only review containers are transferred
        $response = $this->docker->request('GET', '/containers/json', [
            'query' => [
                'all' => '1',
                'filters' => json_encode(['label' => ['review.mr']], \JSON_THROW_ON_ERROR),
            ],
        ]);

        return json_decode($response->getContent(), true, 512, \JSON_THROW_ON_ERROR);
    }

    /**
     * Groups all containers of one MR: the app carries the metadata, every other
     * container with review.role=service becomes a sub-service (link and/or status).
     *
     * @param list<array<string, mixed>> $containers
     *
     * @return list<array<string, mixed>>
     */
    private function group(array $containers): array
    {
        $groups = [];
        foreach ($containers as $c) {
            $l = $c['Labels'] ?? [];
            $mr = (int) ($l['review.mr'] ?? 0);
            if (0 === $mr) {
                continue;
            }
            // MR IIDs are only unique per project
            $project = $l['review.project'] ?? '';
            $key = $project."\0".$mr;

            $groups[$key] ??= ['project' => $project, 'mr' => $mr, 'app' => null, 'services' => []];

            if ('app' === ($l['review.role'] ?? 'app')) {
                $groups[$key]['app'] = [
                    'title' => $l['review.title'] ?? '',
                    'branch' => $l['review.branch'] ?? '',
                    'commit' => $l['review.commit'] ?? '',
                    'author' => $l['review.author'] ?? '',
                    'url' => $l['review.url'] ?? '',
                    'mr_url' => $l['review.mr_url'] ?? '',
                    'deployed_at' => $l['review.deployed_at'] ?? '',
                    'state' => $c['State'] ?? 'unknown',
                    'status' => $c['Status'] ?? '',
                ];
            } else {
                $groups[$key]['services'][] = [
                    'name' => $l['review.service.name'] ?? ($l['com.docker.compose.service'] ?? '?'),
                    'url' => $l['review.service.url'] ?? '',
                    'order' => (int) ($l['review.service.order'] ?? 100),
                    'state' => $c['State'] ?? 'unknown',
                    'status' => $c['Status'] ?? '',
                ];
            }
        }

        foreach ($groups as &$g) {
            usort($g['services'], static fn (array $a, array $b): int => [$a['order'], $a['name']] <=> [$b['order'], $b['name']]);
        }
        unset($g);

        $groups = array_values($groups);
        usort($groups, static fn (array $a, array $b): int => [$a['project'], $b['mr']] <=> [$b['project'], $a['mr']]);

        return $groups;
    }
}
