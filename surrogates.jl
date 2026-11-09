# Surrogate generation, done by TimeseriesSurrogates.jl.
#
#   {"returns":[...], "count":2, "method":"aaft", "seed":7, "block":8}   on stdin
#   {"engine":"TimeseriesSurrogates.jl", "method":"aaft", "series":[[...]]} on stdout
#
# Surrogates are built from the *returns*, not the closes, so the caller can rebuild
# the price path, keep the first close and the timestamps, and hand the agents
# exactly the series that is drawn in the web view — one surrogate, one path.

using TimeseriesSurrogates
using Random
using JSON

const SUPPORTED = Dict(
    "aaft" => () -> AAFT(),
    "iaaft" => () -> IAAFT(),
    "shuffle" => () -> RandomShuffle(),
    "ft" => () -> RandomFourier(),
    "partial" => () -> PartialRandomization(0.7),
    "block" => (b) -> BlockShuffle(Int(b)),
)

function amplitude_match!(s::Vector{Float64}, target::Vector{Float64})
    μ = sum(target) / length(target)
    σ = sqrt(sum((x - μ)^2 for x in target) / max(1, length(target) - 1))
    m = sum(s) / length(s)
    s2 = sqrt(sum((x - m)^2 for x in s) / max(1, length(s) - 1))
    if s2 > 0
        @inbounds for i in eachindex(s)
            s[i] = μ + (s[i] - m) / s2 * σ
        end
    end
    return s
end

function main()
    payload = JSON.parse(read(stdin, String))
    returns = Float64.(get(payload, "returns", Float64[]))
    count = Int(get(payload, "count", 1))
    method = lowercase(String(get(payload, "method", "aaft")))
    seed = Int(get(payload, "seed", 1))
    block = Int(get(payload, "block", 8))

    length(returns) ≥ 20 || error("need at least 20 returns, got $(length(returns))")
    method ∈ keys(SUPPORTED) || error("unsupported method: $method")

    make = SUPPORTED[method]
    generator = startswith(method, "block") ? make(block) : make()

    series = Vector{Vector{Float64}}()
    for k in 1:count
        # a fresh, reproducible rng per surrogate: same seed + same index always
        # yields the same series, so surrogate 3 is surrogate 3 on every run
        Random.seed!(seed * 7919 + k * 104729 + 13)
        s = Vector{Float64}(surrogate(returns, generator))
        amplitude_match!(s, returns)
        push!(series, s)
    end

    JSON.print(stdout, Dict(
        "engine" => "TimeseriesSurrogates.jl",
        "method" => method,
        "julia" => string(VERSION),
        "series" => series,
    ))
end

main()
