<?php

declare(strict_types=1);

namespace App\Controller;

use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;

final class DashboardController extends AbstractController
{
    #[Route('/', name: 'dashboard', methods: ['GET', 'HEAD'])]
    public function index(Request $request): Response
    {
        // Backwards compatibility for scripts using the old "?format=json" URL
        if ('json' === $request->query->get('format')) {
            return $this->forward(ApiController::class.'::environments');
        }

        // The page is only a shell, data is loaded by <review-environments> from the API
        return $this->render('dashboard.html.twig');
    }
}
