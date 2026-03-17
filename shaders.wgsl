// --- UNIFORMS & STRUCTURES ---
struct Params {
    dt: f32,
    bFieldStrength: f32,
    temperature: f32,
    majorRadius: f32,
    minorRadius: f32,
    activeParticles: u32,
    padding1: u32,
    padding2: u32,
};

struct Particle {
    pos: vec4f, // w is mass
    vel: vec4f, // w is charge
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;

// --- COMPUTE SHADER (Physics) ---
@compute @workgroup_size(256)
fn computeMain(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let index = global_id.x;
    if (index >= params.activeParticles) { return; }

    var p = particles[index];
    
    // Tokamak Toroidal & Poloidal Magnetic Field Calculation
    let r_cyl = sqrt(p.pos.x * p.pos.x + p.pos.z * p.pos.z);
    let phi = atan2(p.pos.z, p.pos.x);
    
    // Toroidal field (B_phi) scales as 1/R
    let B_t = params.bFieldStrength * (params.majorRadius / max(r_cyl, 0.001));
    let dir_t = vec3f(-sin(phi), 0.0, cos(phi));
    
    // Poloidal field (B_theta) - simplified gradient
    let dy = p.pos.y;
    let dr = r_cyl - params.majorRadius;
    let B_p = params.bFieldStrength * 0.1 * sqrt(dr*dr + dy*dy);
    let theta = atan2(dy, dr);
    let dir_p = vec3f(-sin(theta)*cos(phi), cos(theta), -sin(theta)*sin(phi));

    // Combined Magnetic Field B
    let B = dir_t * B_t + dir_p * B_p;

    // Boris Integrator for Lorentz Force: F = q(v x B)
    let q = p.vel.w;
    let m = p.pos.w;
    let qm_dt_2 = (q / m) * (params.dt * 0.5);
    
    let t_vec = B * qm_dt_2;
    let t_mag2 = dot(t_vec, t_vec);
    let s_vec = (2.0 * t_vec) / (1.0 + t_mag2);
    
    let v_minus = p.vel.xyz; // Assuming E = 0
    let v_prime = v_minus + cross(v_minus, t_vec);
    let v_plus = v_minus + cross(v_prime, s_vec);
    
    var new_vel = v_plus;

    // Soft confinement (simulating plasma pressure limits)
    let dist_from_center = sqrt(dr*dr + dy*dy);
    if (dist_from_center > params.minorRadius) {
        let normal = vec3f(dr * cos(phi), dy, dr * sin(phi)) / dist_from_center;
        new_vel = new_vel - 2.0 * dot(new_vel, normal) * normal; // Bounce
        new_vel *= 0.9; // Energy loss at wall
    }

    // Thermal agitation (Temperature)
    let speed = length(new_vel);
    let target_speed = params.temperature;
    new_vel = normalize(new_vel) * mix(speed, target_speed, 0.01);

    // Update state
    p.vel = vec4f(new_vel, q);
    p.pos = vec4f(p.pos.xyz + new_vel * params.dt, m);
    particles[index] = p;
}

// --- RENDER SHADER (Visuals) ---
struct Camera {
    viewProj: mat4x4f,
};
@group(1) @binding(0) var<uniform> camera: Camera;

struct VertexOutput {
    @builtin(position) clip_pos: vec4f,
    @location(0) color: vec4f,
};

@vertex
fn vertexMain(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
    var out: VertexOutput;
    let p = particles[vertex_index];
    
    // Energy determines color: Cool (Purple/Red) -> Hot (White/Blue)
    let energy = length(p.vel.xyz);
    let normalized_energy = clamp(energy / 50.0, 0.0, 1.0);
    
    let cool_color = vec3f(0.5, 0.0, 0.8); // Deep Purple
    let mid_color = vec3f(1.0, 0.2, 0.0);  // Plasma Red/Orange
    let hot_color = vec3f(0.8, 0.9, 1.0);  // Blinding Blue/White
    
    var final_color = mix(cool_color, mid_color, smoothstep(0.0, 0.5, normalized_energy));
    final_color = mix(final_color, hot_color, smoothstep(0.5, 1.0, normalized_energy));
    
    out.clip_pos = camera.viewProj * vec4f(p.pos.xyz, 1.0);
    out.color = vec4f(final_color, 0.05); // Low alpha for additive blending
    return out;
}

@fragment
fn fragmentMain(in: VertexOutput) -> @location(0) vec4f {
    return in.color;
}
