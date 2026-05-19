//! Resolve the path to the bundled web frontend and serve it with a
//! SPA-friendly fallback (any unknown route returns `index.html` so
//! React Router can take over).

use std::path::PathBuf;

/// Pick a path for the Vite build output. Configured path wins;
/// otherwise look for `./web/dist` next to the binary, then in CWD.
pub fn resolve_web_dist(configured: &Option<String>) -> PathBuf {
    if let Some(p) = configured {
        return PathBuf::from(p);
    }
    if let Ok(exe) = std::env::current_exe()
        && let Some(parent) = exe.parent()
    {
        let candidate = parent.join("web").join("dist");
        if candidate.exists() {
            return candidate;
        }
    }
    std::env::current_dir()
        .unwrap_or_default()
        .join("web")
        .join("dist")
}

/// Return a tower service that always responds 200 with `index.html`'s
/// bytes. ServeDir uses this as its fallback when no real asset exists
/// at the requested path — exactly the SPA behavior React Router needs.
///
/// ServeDir's built-in `not_found_service` does serve index.html bytes
/// but preserves the 404 status, which most browsers refuse to render.
/// Hence this custom 200 OK fallback.
pub fn spa_fallback(
    index_path: PathBuf,
) -> impl tower::Service<
    axum::extract::Request,
    Response = axum::response::Response,
    Error = std::convert::Infallible,
    Future = std::pin::Pin<
        Box<
            dyn std::future::Future<
                Output = Result<axum::response::Response, std::convert::Infallible>,
            > + Send,
        >,
    >,
> + Clone
+ Send
+ 'static {
    use axum::response::IntoResponse;
    let index_path = std::sync::Arc::new(index_path);
    tower::service_fn(move |_req: axum::extract::Request| {
        let p = index_path.clone();
        Box::pin(async move {
            let body = tokio::fs::read(p.as_path()).await.unwrap_or_default();
            Ok::<_, std::convert::Infallible>(
                (
                    [(axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8")],
                    body,
                )
                    .into_response(),
            )
        })
            as std::pin::Pin<
                Box<
                    dyn std::future::Future<
                        Output = Result<axum::response::Response, std::convert::Infallible>,
                    > + Send,
                >,
            >
    })
}
