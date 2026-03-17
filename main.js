const MAX_PARTICLES = 1_000_000;
const MAJOR_RADIUS = 10.0;
const MINOR_RADIUS = 3.0;

async function init() {
    if (!navigator.gpu) throw new Error("WebGPU not supported on this browser.");
    const adapter = await navigator.gpu.requestAdapter();
    const device = await adapter.requestDevice();
    const canvas = document.getElementById('gpuCanvas');
    const context = canvas.getContext('webgpu');
    const format = navigator.gpu.getPreferredCanvasFormat();
    
    // Handle resizing
    function resize() {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    }
    window.addEventListener('resize', resize);
    resize();
    context.configure({ device, format, alphaMode: 'premultiplied' });

    // Fetch WGSL Code (assuming it's in shaders.wgsl, but we fetch from a local const for ease if hosted directly)
    const response = await fetch('shaders.wgsl');
    const shaderCode = await response.text();
    const shaderModule = device.createShaderModule({ code: shaderCode });

    // Initialize Particles (Deuterium/Tritium mix)
    const particleData = new Float32Array(MAX_PARTICLES * 8); // 8 floats per particle (pos:4, vel:4)
    for (let i = 0; i < MAX_PARTICLES; i++) {
        // Random position within the torus
        const angle = Math.random() * Math.PI * 2;
        const r = Math.random() * MINOR_RADIUS;
        const theta = Math.random() * Math.PI * 2;
        
        particleData[i*8 + 0] = (MAJOR_RADIUS + r * Math.cos(theta)) * Math.cos(angle); // x
        particleData[i*8 + 1] = r * Math.sin(theta); // y
        particleData[i*8 + 2] = (MAJOR_RADIUS + r * Math.cos(theta)) * Math.sin(angle); // z
        particleData[i*8 + 3] = 2.0; // Mass (w)
        
        // Initial Velocity (random thermal drift)
        particleData[i*8 + 4] = (Math.random() - 0.5) * 10.0; // vx
        particleData[i*8 + 5] = (Math.random() - 0.5) * 10.0; // vy
        particleData[i*8 + 6] = (Math.random() - 0.5) * 10.0; // vz
        particleData[i*8 + 7] = 1.0; // Charge (w)
    }

    const particleBuffer = device.createBuffer({
        size: particleData.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(particleBuffer, 0, particleData);

    // Uniforms: Compute Params
    const paramBuffer = device.createBuffer({
        size: 32, // 8 floats
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Uniforms: Camera matrices
    const cameraBuffer = device.createBuffer({
        size: 64, // 4x4 matrix
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Pipelines
    const computePipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module: shaderModule, entryPoint: 'computeMain' }
    });

    const renderPipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: shaderModule, entryPoint: 'vertexMain' },
        fragment: {
            module: shaderModule, entryPoint: 'fragmentMain',
            targets: [{ 
                format,
                blend: { // Additive blending for the glow effect
                    color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' },
                    alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }
                }
            }]
        },
        primitive: { topology: 'point-list' }
    });

    const computeBindGroup = device.createBindGroup({
        layout: computePipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: paramBuffer } },
            { binding: 1, resource: { buffer: particleBuffer } }
        ]
    });

    const renderBindGroup = device.createBindGroup({
        layout: renderPipeline.getBindGroupLayout(1),
        entries: [{ binding: 0, resource: { buffer: cameraBuffer } }]
    });

    // UI & State Elements
    let activeParticles = 500000;
    let bField = 10.0;
    let temp = 30.0;
    
    document.getElementById('particles').oninput = (e) => {
        activeParticles = parseInt(e.target.value);
        document.getElementById('particleVal').innerText = activeParticles.toLocaleString();
    };
    document.getElementById('bField').oninput = (e) => {
        bField = parseFloat(e.target.value);
        document.getElementById('bFieldVal').innerText = bField.toFixed(1);
    };
    document.getElementById('temp').oninput = (e) => {
        temp = parseFloat(e.target.value);
        document.getElementById('tempVal').innerText = temp.toFixed(1);
    };

    // Simple Orbit Camera Implementation
    let camRadius = 25.0, camTheta = Math.PI/4, camPhi = Math.PI/4;
    let isDragging = false, lastX, lastY;
    
    window.addEventListener('mousedown', (e) => { isDragging = true; lastX = e.clientX; lastY = e.clientY; });
    window.addEventListener('mouseup', () => isDragging = false);
    window.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const dx = e.clientX - lastX; const dy = e.clientY - lastY;
        camTheta -= dx * 0.01; camPhi = Math.max(0.1, Math.min(Math.PI - 0.1, camPhi - dy * 0.01));
        lastX = e.clientX; lastY = e.clientY;
    });
    window.addEventListener('wheel', (e) => { camRadius += e.deltaY * 0.05; });

    let lastTime = performance.now();
    let frames = 0;

    // Render Loop
    function frame() {
        const now = performance.now();
        const dt = Math.min((now - lastTime) / 1000.0, 0.1); // Cap dt
        lastTime = now;
        
        // FPS Counter
        frames++;
        if (frames % 10 === 0) {
            document.getElementById('fpsOut').innerText = Math.round(1/dt);
            // Fake physics proxy for energy out: more particles + higher temp + high B-field = more fusion
            let energy = (activeParticles / 10000) * (temp / 10) * (bField / 5);
            document.getElementById('energyOut').innerText = energy.toFixed(2);
        }

        // Update Compute Uniforms (dt, BField, Temp, R, r, ActiveCount)
        const paramsArray = new Float32Array([dt, bField, temp, MAJOR_RADIUS, MINOR_RADIUS]);
        const paramsU32 = new Uint32Array([activeParticles, 0, 0]);
        device.queue.writeBuffer(paramBuffer, 0, paramsArray);
        device.queue.writeBuffer(paramBuffer, 20, paramsU32);

        // Update Camera Matrix
        const proj = mat4.create();
        mat4.perspective(proj, Math.PI / 4, canvas.width / canvas.height, 0.1, 1000.0);
        
        const camX = camRadius * Math.sin(camPhi) * Math.sin(camTheta);
        const camY = camRadius * Math.cos(camPhi);
        const camZ = camRadius * Math.sin(camPhi) * Math.cos(camTheta);
        
        const view = mat4.create();
        mat4.lookAt(view, [camX, camY, camZ], [0, 0, 0], [0, 1, 0]);
        
        const viewProj = mat4.create();
        mat4.multiply(viewProj, proj, view);
        device.queue.writeBuffer(cameraBuffer, 0, viewProj);

        // Encode Commands
        const commandEncoder = device.createCommandEncoder();

        // 1. Compute Pass
        const computePass = commandEncoder.beginComputePass();
        computePass.setPipeline(computePipeline);
        computePass.setBindGroup(0, computeBindGroup);
        computePass.dispatchWorkgroups(Math.ceil(MAX_PARTICLES / 256));
        computePass.end();

        // 2. Render Pass
        const textureView = context.getCurrentTexture().createView();
        const renderPass = commandEncoder.beginRenderPass({
            colorAttachments: [{
                view: textureView, clearValue: { r: 0.0, g: 0.0, b: 0.02, a: 1.0 },
                loadOp: 'clear', storeOp: 'store'
            }]
        });
        renderPass.setPipeline(renderPipeline);
        renderPass.setBindGroup(1, renderBindGroup);
        renderPass.draw(activeParticles, 1, 0, 0);
        renderPass.end();

        device.queue.submit([commandEncoder.finish()]);
        requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
}

init().catch(console.error);
